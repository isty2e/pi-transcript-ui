import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import { Worker } from "node:worker_threads";

export type ObservedOutputItem =
  | { readonly type: "text"; readonly text: string; readonly console?: true }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface OutputWitness {
  readonly items: readonly ObservedOutputItem[];
  readonly terminal: { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly error: string };
}

type Completion = (witness: OutputWitness | undefined) => void;
type Claim = (toolCallId: string) => Completion | undefined;
type Callable = (this: unknown, ...args: unknown[]) => unknown;
interface Replacement { target: object; key: string; before: PropertyDescriptor | undefined; installed: PropertyDescriptor }
interface Candidate { items: ObservedOutputItem[]; terminal: OutputWitness["terminal"] | undefined; touched: boolean }

const then = Promise.prototype.then;

function descriptorInChain(target: object, key: string): PropertyDescriptor | undefined {
  let owner: object | null = target;
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor;
    owner = Object.getPrototypeOf(owner);
  }
  return undefined;
}

function fields(value: unknown): Record<string, PropertyDescriptor> {
  if (value === null || typeof value !== "object") throw new Error();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(field => !("value" in field))) throw new Error();
  return descriptors;
}

function only(record: Record<string, PropertyDescriptor>, keys: readonly string[]): void {
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error();
}

function outputItem(value: unknown): ObservedOutputItem {
  const item = fields(value);
  if (item.type?.value === "text" && typeof item.text?.value === "string") {
    only(item, ["type", "text", "console"]);
    if (item.console && item.console.value !== true) throw new Error();
    return Object.freeze(item.console ? { type: "text", text: item.text.value, console: true }
      : { type: "text", text: item.text.value });
  }
  if (item.type?.value === "image" && typeof item.data?.value === "string" && typeof item.mimeType?.value === "string") {
    only(item, ["type", "data", "mimeType"]);
    return Object.freeze({ type: "image", data: item.data.value, mimeType: item.mimeType.value });
  }
  throw new Error();
}

function terminal(message: Record<string, PropertyDescriptor>): OutputWitness["terminal"] {
  const during = message.during;
  if (during) {
    const value = fields(during.value);
    only(value, ["seq", "issued"]);
    for (const key of ["seq", "issued"]) {
      if (!Number.isSafeInteger(value[key]?.value) || value[key]!.value < 0) throw new Error();
    }
  }
  if (message.ok?.value === true && typeof message.writes?.value === "string" && message.value &&
      (message.value.value === undefined || typeof message.value.value === "string")) {
    only(message, ["type", "ok", "value", "writes", "during"]);
    return Object.freeze(message.value.value === undefined ? { ok: true } : { ok: true, value: message.value.value });
  }
  if (message.ok?.value === false && typeof message.error?.value === "string") {
    only(message, ["type", "ok", "error", "during"]);
    return Object.freeze({ ok: false, error: message.error.value });
  }
  throw new Error();
}

class Capture {
  private completion: Completion | undefined;
  private readonly candidates = new Set<Candidate>();
  private invalid = false;
  closed = false;

  constructor(completion: Completion) { this.completion = completion; }

  candidate(): Candidate {
    const candidate: Candidate = { items: [], terminal: undefined, touched: false };
    this.candidates.add(candidate);
    return candidate;
  }

  invalidate(): void {
    this.invalid = true;
    for (const candidate of this.candidates) { candidate.items = []; candidate.terminal = undefined; }
  }

  observe(candidate: Candidate, value: unknown): void {
    if (this.closed || this.invalid) return;
    try {
      // Worker messages are structured-cloned plain data. Never evaluate an accessor to inspect them.
      if (value === null || typeof value !== "object") return;
      const message = fields(value), kind = message.type?.value;
      if (kind !== "output" && kind !== "done" && kind !== "crash") return;
      candidate.touched = true;
      if (candidate.terminal || kind === "crash") throw new Error();
      if (kind === "output") {
        only(message, ["type", "item"]);
        candidate.items.push(outputItem(message.item?.value));
      } else candidate.terminal = terminal(message);
    } catch { this.invalidate(); }
  }

  finish(report: boolean): void {
    if (this.closed) return;
    this.closed = true;
    const completion = this.completion;
    this.completion = undefined;
    const touched = [...this.candidates].filter(candidate => candidate.touched);
    const candidate = touched.length === 1 ? touched[0] : undefined;
    const witness: OutputWitness | undefined = report && !this.invalid && candidate?.terminal
      ? Object.freeze({ items: Object.freeze(candidate.items), terminal: candidate.terminal }) : undefined;
    this.invalidate(); this.candidates.clear();

    if (report) {
      try { completion?.(witness); } catch { /* Observation cannot change execution. */ }
    }
  }
}

interface State {
  active: boolean;
  claim: Claim | undefined;
  scopes: AsyncLocalStorage<Capture>;
  captures: Set<Capture>;
  workers: WeakMap<Worker, Capture>;
}

function sameDescriptor(left: PropertyDescriptor | undefined, right: PropertyDescriptor): boolean {
  return left?.value === right.value && left?.writable === right.writable &&
    left?.enumerable === right.enumerable && left?.configurable === right.configurable && !left?.get && !left?.set;
}

function restore(replacement: Replacement): void {
  try {
    if (!sameDescriptor(Object.getOwnPropertyDescriptor(replacement.target, replacement.key), replacement.installed)) return;
    if (replacement.before) Object.defineProperty(replacement.target, replacement.key, replacement.before);
    else Reflect.deleteProperty(replacement.target, replacement.key);
  } catch { /* A foreign owner may have made restoration unavailable. */ }
}

function executeWrapper(state: State, original: Callable): Callable {
  return function (this: unknown, ...args: unknown[]): unknown {
    let capture: Capture | undefined;
    if (state.active && typeof args[0] === "string") {
      try {
        const completion = state.claim?.(args[0]);
        if (state.active && typeof completion === "function") {
          capture = new Capture(completion); state.captures.add(capture);
        }
      } catch { /* A failed claim does not intercept the call. */ }
    }
    if (!capture) return state.active ? state.scopes.exit(() => Reflect.apply(original, this, args))
      : Reflect.apply(original, this, args);
    const scope = capture;
    const finish = () => {
      state.captures.delete(scope);
      scope.finish(state.active);
    };

    let result: unknown;
    try { result = state.scopes.run(scope, () => Reflect.apply(original, this, args)); }
    catch (error) { finish(); throw error; }

    if (types.isPromise(result)) {
      try { Reflect.apply(then, result, [finish, finish]); }
      catch { state.captures.delete(scope); scope.finish(false); }
    } else finish();
    return result;
  };
}

function workerWrapper(state: State, original: Callable): Callable {
  return function (this: unknown, ...args: unknown[]): unknown {
    let listener = args[1];
    const capture = state.active ? state.scopes.getStore() : undefined;
    if (capture && !capture.closed && args[0] === "message") {
      try {
        // EventEmitter.once() registers an internal wrapper with a .listener property. Leave it untouched.
        if (this instanceof Worker && typeof listener === "function" &&
            !descriptorInChain(listener, "listener")) {
          const prior = state.workers.get(this);
          if (prior) {
            if (prior !== capture) { prior.invalidate(); capture.invalidate(); }
          } else {
            const candidate = capture.candidate(), next = listener;
            const observe = function (this: unknown, ...messages: unknown[]): unknown {
              capture.observe(candidate, messages[0]);
              return Reflect.apply(next, this, messages);
            };
            Object.defineProperty(observe, "listener", { value: next });
            state.workers.set(this, capture);
            listener = observe;
          }
        }
      } catch { capture.invalidate(); }
    }
    if (listener === args[1]) return Reflect.apply(original, this, args);
    const forwarded = [...args]; forwarded[1] = listener;
    return Reflect.apply(original, this, forwarded);
  };
}

export class CodemodeOutputObserver {
  private readonly state: State;
  private readonly definitions = new Map<object, Replacement>();
  private tap: Replacement | undefined;

  constructor(claim: Claim) {
    this.state = { active: true, claim, scopes: new AsyncLocalStorage(), captures: new Set(), workers: new WeakMap() };
  }

  watch(definition: object): boolean {
    if (!this.state.active) return false;
    try {
      const prior = this.definitions.get(definition);
      if (prior) return sameDescriptor(Object.getOwnPropertyDescriptor(definition, "execute"), prior.installed) &&
        this.tap !== undefined && sameDescriptor(Object.getOwnPropertyDescriptor(Worker.prototype, "on"), this.tap.installed);
      const before = Object.getOwnPropertyDescriptor(definition, "execute");
      if (!before || !("value" in before) || typeof before.value !== "function" || (!before.configurable && !before.writable)) return false;
      if (!this.installTap()) return false;
      const installed = { ...before, value: executeWrapper(this.state, before.value as Callable) };
      Object.defineProperty(definition, "execute", installed);
      this.definitions.set(definition, { target: definition, key: "execute", before, installed });
      return true;
    } catch {
      if (this.definitions.size === 0 && this.tap) { restore(this.tap); this.tap = undefined; }
      return false;
    }
  }

  private installTap(): boolean {
    if (this.tap) return sameDescriptor(Object.getOwnPropertyDescriptor(Worker.prototype, "on"), this.tap.installed);
    const before = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
    const descriptor = before ?? descriptorInChain(Worker.prototype, "on");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function" ||
        (before && !before.configurable && !before.writable)) return false;
    const installed = { ...(before ?? { configurable: true, writable: true, enumerable: false }),
      value: workerWrapper(this.state, descriptor.value as Callable) };
    Object.defineProperty(Worker.prototype, "on", installed);
    this.tap = { target: Worker.prototype, key: "on", before, installed };
    return true;
  }

  dispose(): void {
    this.state.active = false; this.state.claim = undefined;
    for (const capture of this.state.captures) capture.finish(false);
    this.state.captures.clear(); this.state.workers = new WeakMap(); this.state.scopes.disable();
    for (const replacement of this.definitions.values()) restore(replacement);
    this.definitions.clear();
    if (this.tap) restore(this.tap);
    this.tap = undefined;
  }
}
