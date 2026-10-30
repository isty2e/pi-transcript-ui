import * as Pi from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./intent.js";

const OWNER = Symbol.for("pi-transcript-ui.native-mode-observer.v1");
const METHOD = "renderSessionEntries";
type NativeCall = (this: unknown, ...args: unknown[]) => unknown;
type Receiver = (mode: unknown, original: NativeCall, args: unknown[]) => (() => unknown) | undefined;

export interface NativeModeObservation {
  readonly mode: unknown;
  readonly error: unknown;
  dispose(): void;
}

interface Client {
  readonly handler: unknown;
  readonly alive: () => boolean;
  readonly receive: Receiver;
  mode: unknown;
  error: unknown;
}

interface Broker {
  readonly protocol: 1;
  subscribe(handler: unknown, alive: () => boolean, receive: Receiver): NativeModeObservation;
  cleanup(): void;
}

export class NativeModeCleanupError extends Error {
  constructor(cause: unknown, readonly retryCleanup: () => void) {
    super("Native mode discovery cleanup is incomplete", { cause });
  }
}

function matches(mode: unknown, handler: unknown): boolean {
  if (!isRecord(mode) || !isRecord(mode.session) || !isRecord(mode.session.extensionRunner)) return false;
  const runner = mode.session.extensionRunner;
  if (typeof runner.resolveRegisteredCommands !== "function") return false;
  const commands: unknown = Reflect.apply(runner.resolveRegisteredCommands, runner, []);
  return Array.isArray(commands) && commands.some(command => isRecord(command) && command.handler === handler);
}

function createBroker(prototype: object): Broker {
  const before = Object.getOwnPropertyDescriptor(prototype, METHOD);
  const original: unknown = before?.value;
  if (!before?.configurable || !before.writable || typeof original !== "function")
    throw new Error("Native source observation is unsupported");
  const invoke = original as NativeCall;
  const clients = new Set<Client>();
  let state: "listening" | "cleanup-pending" | "disposed" = "listening";

  function cleanup(): void {
    if (state === "disposed" || clients.size) return;
    state = "cleanup-pending";
    if (Object.getOwnPropertyDescriptor(prototype, METHOD)?.value === observe &&
        !Reflect.defineProperty(prototype, METHOD, before!)) throw new NativeModeCleanupError(undefined, cleanup);
    if (Object.getOwnPropertyDescriptor(prototype, OWNER)?.value === broker && !Reflect.deleteProperty(prototype, OWNER))
      throw new NativeModeCleanupError(undefined, cleanup);
    state = "disposed";
  }

  function observe(this: unknown, ...args: unknown[]): unknown {
    if (state !== "listening") return Reflect.apply(invoke, this, args);
    let continuation: (() => unknown) | undefined;
    try {
      for (const client of clients) {
        let alive = false;
        try { alive = client.alive(); } catch { /* Invalidated extension APIs cannot acquire a mode. */ }
        if (!alive) clients.delete(client);
      }
      const matching = [...clients].filter(client => {
        try { return matches(this, client.handler); } catch { return false; }
      });
      if (matching.length === 1) {
        const client = matching[0]!;
        clients.delete(client);
        try {
          cleanup();
          client.mode = this;
          continuation = client.receive(this, invoke, args);
        } catch (error) {
          client.mode = undefined; client.error = error;
          continuation = undefined;
        }
      } else if (!clients.size) cleanup();
    } catch { /* Keep observer/cleanup errors separate from the native call's outcome. */ }
    return continuation ? continuation() : Reflect.apply(invoke, this, args);
  }

  const broker: Broker = {
    protocol: 1,
    cleanup,
    subscribe(handler, alive, receive) {
      if (state !== "listening") throw new NativeModeCleanupError(undefined, cleanup);
      const client: Client = { handler, alive, receive, mode: undefined, error: undefined };
      clients.add(client);
      return {
        get mode() { return client.mode; },
        get error() { return client.error; },
        dispose() { clients.delete(client); client.mode = undefined; cleanup(); },
      };
    },
  };

  Object.defineProperty(prototype, OWNER, { configurable: true, value: broker });
  try { Object.defineProperty(prototype, METHOD, { ...before, value: observe }); }
  catch (error) {
    try { cleanup(); } catch (failure) { throw new NativeModeCleanupError(new AggregateError([error, failure]), cleanup); }
    throw error;
  }
  return broker;
}

export function observeNativeMode(api: ExtensionAPI, handler: unknown, receive: Receiver): NativeModeObservation {
  const host = Pi as unknown as Record<string, unknown>, constructor = host.InteractiveMode;
  if (typeof constructor !== "function" || !isRecord(constructor.prototype)) throw new Error("Native mode discovery is unsupported");
  const prototype = constructor.prototype as object;
  const previous: unknown = Object.getOwnPropertyDescriptor(prototype, OWNER)?.value;
  if (previous !== undefined && (!isRecord(previous) || previous.protocol !== 1 ||
      typeof previous.subscribe !== "function" || typeof previous.cleanup !== "function"))
    throw new Error("Native mode discovery has a foreign owner");
  const broker = previous as Broker | undefined ?? createBroker(prototype);
  try {
    return broker.subscribe(handler, () => {
      api.getFlag("__transcript_ui_discovery_liveness__");
      return true;
    }, receive);
  } catch (error) {
    throw new NativeModeCleanupError(error, () => broker.cleanup());
  }
}
