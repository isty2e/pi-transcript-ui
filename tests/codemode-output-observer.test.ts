import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodemodeOutputObserver, type OutputWitness } from "../src/codemode/output-observer.js";

const baselineOn = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
const observers: CodemodeOutputObserver[] = [], workers: Worker[] = [];

function observer(claim: ConstructorParameters<typeof CodemodeOutputObserver>[0]) {
  const value = new CodemodeOutputObserver(claim); observers.push(value); return value;
}

function worker() {
  const value = new Worker(`const {parentPort} = require('node:worker_threads');
    parentPort.on('message', message => parentPort.postMessage(message));`, { eval: true });
  workers.push(value); return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const output = (text: string) => ({ type: "output", item: { type: "text", text } });
const done = (value?: string) => ({ type: "done", ok: true, value, writes: "[]" });

function capture(messages: unknown[]) {
  const receive = vi.fn<(value: OutputWitness | undefined) => void>(), source = worker();
  const definition = { execute() {
    source.on("message", () => {});
    for (const message of messages) source.emit("message", message);
    return "native result";
  } };
  const watch = observer(() => receive);
  expect(watch.watch(definition)).toBe(true);
  expect(Reflect.apply(definition.execute, definition, ["id"])).toBe("native result");
  expect(receive).toHaveBeenCalledTimes(1);
  return receive.mock.calls[0]![0];
}

afterEach(async () => {
  for (const value of observers.splice(0).reverse()) value.dispose();
  if (baselineOn) Object.defineProperty(Worker.prototype, "on", baselineOn);
  else Reflect.deleteProperty(Worker.prototype, "on");
  await Promise.all(workers.splice(0).map(value => value.terminate()));
});

describe("native codemode output observation", () => {
  it("watches without calling the tool and preserves own descriptor flags and synchronous identity", () => {
    const result = {}, args = ["id", {}, new AbortController().signal, () => {}, {}], receiver = {};
    const execute = vi.fn(function (this: unknown, ...actual: unknown[]) {
      expect(this).toBe(receiver); actual.forEach((value, index) => expect(value).toBe(args[index]));
      expect(actual).toHaveLength(args.length); return result;
    });
    const definition = Object.defineProperty({}, "execute", { value: execute, writable: true, configurable: false, enumerable: false });
    const before = Object.getOwnPropertyDescriptor(definition, "execute")!;
    const receive = vi.fn(), claim = vi.fn(() => receive), watch = observer(claim);
    expect(watch.watch(definition)).toBe(true); expect(watch.watch(definition)).toBe(true);
    expect(execute).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
    const wrapped = Object.getOwnPropertyDescriptor(definition, "execute")!;
    expect(wrapped).toMatchObject({ writable: true, configurable: false, enumerable: false });
    expect(Reflect.apply(wrapped.value, receiver, args)).toBe(result);
    expect(execute).toHaveBeenCalledTimes(1); expect(claim).toHaveBeenCalledExactlyOnceWith("id");
    expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
    watch.dispose(); expect(Object.getOwnPropertyDescriptor(definition, "execute")).toEqual(before);
  });

  it("preserves the original synchronous exception and calls completion once", () => {
    const failure = {}, receive = vi.fn(), execute = vi.fn(() => { throw failure; });
    const definition = { execute }, watch = observer(() => receive); watch.watch(definition);
    try { Reflect.apply(definition.execute, undefined, ["id"]); expect.unreachable(); }
    catch (error) { expect(error).toBe(failure); }
    expect(execute).toHaveBeenCalledTimes(1); expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("returns the exact original Promise and reports before the caller's await continuation", async () => {
    const source = worker(), run = deferred<object>(), result = {}, order: string[] = [];
    const original = vi.fn(() => {
      source.on("message", () => {}); source.emit("message", done(' {"kept": 1} ')); return run.promise;
    }), definition = { execute: original };
    const receive = vi.fn(() => { order.push("observer"); });
    observer(() => receive).watch(definition);
    const actual = Reflect.apply(definition.execute, undefined, ["id"]);
    expect(actual).toBe(run.promise); expect(receive).not.toHaveBeenCalled(); run.resolve(result);
    expect(await actual).toBe(result); order.push("caller");
    expect(order).toEqual(["observer", "caller"]); expect(original).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [], terminal: { ok: true, value: ' {"kept": 1} ' } });
  });

  it("preserves rejection identity without replacing the Promise or using an overridden then", async () => {
    const run = deferred<never>(), failure = {}, receive = vi.fn();
    const ownThen = vi.fn(() => { throw new Error(); }); Object.defineProperty(run.promise, "then", { value: ownThen });
    const definition = { execute: () => run.promise }; observer(() => receive).watch(definition);
    const actual = Reflect.apply(definition.execute, null, ["id"]);
    expect(actual).toBe(run.promise); run.reject(failure);
    try { await actual; expect.unreachable(); } catch (error) { expect(error).toBe(failure); }
    expect(ownThen).not.toHaveBeenCalled(); expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not inspect thenables or invoke getters on synchronous results", () => {
    const getter = vi.fn(() => { throw new Error(); });
    const result = Object.defineProperty({}, "then", { get: getter }), definition = { execute: () => result }, receive = vi.fn();
    observer(() => receive).watch(definition);
    expect(Reflect.apply(definition.execute, undefined, ["id"])).toBe(result);
    expect(getter).not.toHaveBeenCalled(); expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("retires an unobservable Promise without guessing settlement or changing the returned object", async () => {
    const source = worker(), run = deferred<number>(), receive = vi.fn(), failure = {};
    const getter = vi.fn(() => { throw failure; });
    Object.defineProperty(run.promise, "constructor", { get: getter, configurable: true });
    let calls = 0;
    const definition = { execute() {
      calls++; source.on("message", () => {}); source.emit("message", output("discard")); return run.promise;
    } };
    observer(() => receive).watch(definition);
    const result = Reflect.apply(definition.execute, null, ["id"]);
    const identical = result === run.promise;
    source.emit("message", done("late")); Object.defineProperty(run.promise, "constructor", { value: Promise });
    expect(identical).toBe(true); expect(calls).toBe(1); expect(getter).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
    run.resolve(9); expect(await result).toBe(9); expect(receive).not.toHaveBeenCalled();
  });

  it("leaves unsupported, inherited, accessor and frozen execute shapes alone without getters", () => {
    const getter = vi.fn(() => () => {}), prototype = { execute() {} };
    const definitions = [Object.create(prototype), Object.defineProperty({}, "execute", { get: getter }),
      Object.freeze({ execute() {} }), { execute: "not callable" }, {}];
    const watch = observer(() => undefined), before = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
    for (const definition of definitions) expect(watch.watch(definition)).toBe(false);
    expect(getter).not.toHaveBeenCalled(); expect(Object.getOwnPropertyDescriptor(Worker.prototype, "on")).toEqual(before);
  });

  it("declines cross-process-style definition proxies without reflective calls", () => {
    const reflect = vi.fn(() => { throw new Error(); });
    const definition = new Proxy({ execute() {} }, { getOwnPropertyDescriptor: reflect, getPrototypeOf: reflect });
    const before = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
    expect(observer(() => undefined).watch(definition)).toBe(false);
    expect(reflect).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(Worker.prototype, "on")).toEqual(before);
  });

  it("rolls back a tap when installing execute fails", () => {
    const definition = Object.preventExtensions({ execute() {} });
    const proxy = new Proxy(definition, { defineProperty() { throw new Error(); } });
    const before = Object.getOwnPropertyDescriptor(Worker.prototype, "on"), watch = observer(() => undefined);
    expect(watch.watch(proxy)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(Worker.prototype, "on")).toEqual(before);
  });

  it("rejects unavailable worker tap descriptors without reading an accessor", () => {
    const getter = vi.fn(() => EventEmitter.prototype.on);
    Object.defineProperty(Worker.prototype, "on", { configurable: true, get: getter });
    const definition = { execute() {} }, original = definition.execute;
    expect(observer(() => undefined).watch(definition)).toBe(false);
    expect(definition.execute).toBe(original); expect(getter).not.toHaveBeenCalled();
  });

  it("does not claim missing/non-string IDs and leaves unclaimed registrations unchanged", () => {
    const source = worker(), listener = () => {}, receive = vi.fn();
    const claim = vi.fn((id: string) => id === "eligible" ? receive : undefined);
    const definition = { execute() { source.on("message", listener); } }; observer(claim).watch(definition);
    for (const args of [[], [1], [undefined], ["unclaimed"]]) Reflect.apply(definition.execute, null, args);
    expect(claim).toHaveBeenCalledExactlyOnceWith("unclaimed"); expect(receive).not.toHaveBeenCalled();
    expect(source.rawListeners("message")).toEqual([listener, listener, listener, listener]);
  });

  it("swallows claim failures without changing the original invocation", () => {
    const execute = vi.fn(() => 5), definition = { execute };
    observer(() => { throw new Error(); }).watch(definition);
    expect(Reflect.apply(definition.execute, undefined, ["id"])).toBe(5); expect(execute).toHaveBeenCalledTimes(1);
  });

  it("allows a claim to dispose the observer without retaining or calling its completion", () => {
    const receive = vi.fn(), original = vi.fn(() => 5), definition = { execute: original };
    const watch = observer(() => { watch.dispose(); return receive; }); watch.watch(definition);
    expect(Reflect.apply(definition.execute, undefined, ["id"])).toBe(5);
    expect(original).toHaveBeenCalledTimes(1); expect(receive).not.toHaveBeenCalled();
  });

  it("snapshots ordered text, console, images and the raw terminal string without retaining store writes", () => {
    const text = output("first"), console = { type: "output", item: { type: "text", text: "log", console: true } };
    const image = { type: "output", item: { type: "image", data: "base64", mimeType: "image/png" } };
    const end = { ...done('{"raw":1}'), writes: '[["private","payload"]]', during: { seq: 0, issued: 2 } };
    const witness = capture([text, console, image, end])!;
    text.item.text = "changed"; console.item.text = "changed"; image.item.data = "changed"; end.value = "changed";
    expect(witness).toEqual({ items: [{ type: "text", text: "first" }, { type: "text", text: "log", console: true },
      { type: "image", data: "base64", mimeType: "image/png" }], terminal: { ok: true, value: '{"raw":1}' } });
    expect(Object.isFrozen(witness)).toBe(true); expect(Object.isFrozen(witness.items)).toBe(true);
    for (const item of witness.items) expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(witness.terminal)).toBe(true);
  });

  it("captures empty success and plain script failure forms without parsing", () => {
    expect(capture([done()])).toEqual({ items: [], terminal: { ok: true } });
    expect(capture([{ type: "done", ok: true, writes: "[]" }])).toEqual({ items: [], terminal: { ok: true } });
    expect(capture([output("before error"), { type: "done", ok: false, error: '{"message":"failed"}' }]))
      .toEqual({ items: [{ type: "text", text: "before error" }], terminal: { ok: false, error: '{"message":"failed"}' } });
  });

  it.each([
    [output("partial")],
    [{ type: "output", item: { type: "text", text: 1 } }, done()],
    [{ type: "output", item: { type: "text", text: "x", console: false } }, done()],
    [{ type: "output", item: { type: "image", data: "x" } }, done()],
    [{ type: "output", item: { type: "future", text: "x" } }, done()],
    [{ type: "output", item: { type: "text", text: "x", extra: true } }, done()],
    [{ type: "done", ok: true, value: 1, writes: "[]" }],
    [{ type: "done", ok: true, value: undefined }],
    [{ type: "done", ok: false, error: {} }],
    [{ type: "done", ok: "true", value: "1", writes: "[]" }],
    [{ ...done(), during: { seq: -1, issued: 0 } }],
    [done(), done()],
    [done(), output("late")],
    [{ type: "crash", message: "native failure" }],
  ])("declines malformed, incomplete, duplicate or after-terminal observations (%#)", (...messages) => {
    expect(capture(messages)).toBeUndefined();
  });

  it("does not evaluate malformed message/item accessors and still forwards their exact identity", () => {
    const getter = vi.fn(() => { throw new Error(); }), message = Object.defineProperty({}, "type", { get: getter });
    const item = Object.defineProperty({ type: "text" }, "text", { get: getter });
    expect(capture([message, done()])).toBeUndefined();
    expect(capture([{ type: "output", item }, done()])).toBeUndefined(); expect(getter).not.toHaveBeenCalled();
  });

  it("swallows inspection traps and callback exceptions while preserving execution", async () => {
    const message = new Proxy({}, { getPrototypeOf() { throw new Error(); } });
    expect(capture([message, done()])).toBeUndefined();
    const source = worker(), receive = vi.fn(() => { throw new Error(); }), run = deferred<number>();
    const definition = { execute() { source.on("message", () => {}); source.emit("message", done()); return run.promise; } };
    observer(() => receive).watch(definition);
    const result = Reflect.apply(definition.execute, null, ["id"]); run.resolve(7);
    expect(await result).toBe(7); expect(receive).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("ignores unrelated messages but never treats absence of a worker as empty output", () => {
    expect(capture([null, "unrelated", { type: "call", name: "tool" }, { type: "started", fingerprint: "x" },
      { type: "idle", seq: 0, issued: 0 }, { "watch:import": [] }, done()]))
      .toEqual({ items: [], terminal: { ok: true } });
    expect(capture([{ type: "call" }])).toBeUndefined();
    const receive = vi.fn(), definition = { execute: () => "native" }; observer(() => receive).watch(definition);
    Reflect.apply(definition.execute, null, ["id"]); expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("never merges multiple VM candidates, including an incomplete additional candidate", () => {
    for (const second of [[done()], [output("incomplete")], [{ type: "crash", message: "failed" }]]) {
      const one = worker(), two = worker(), receive = vi.fn();
      const definition = { execute() {
        one.on("message", () => {}); two.on("message", () => {});
        one.emit("message", done("1")); for (const message of second) two.emit("message", message);
      } };
      observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
      expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
    }
  });

  it("keeps reordered overlapping invocation scopes separate across async continuations", async () => {
    const sources = [worker(), worker()], gates = [deferred<void>(), deferred<void>()];
    const completions = [vi.fn(), vi.fn()], originals: Promise<number>[] = [];
    const definition = { execute(id: string) {
      const index = Number(id);
      const promise = (async () => {
        await gates[index]!.promise;
        const source = sources[index]!; source.on("message", () => {});
        source.emit("message", output(id)); source.emit("message", done(id)); return index;
      })();
      originals[index] = promise; return promise;
    } };
    observer(id => completions[Number(id)]).watch(definition);
    const first = definition.execute("0"), second = definition.execute("1");
    expect(first).toBe(originals[0]); expect(second).toBe(originals[1]);
    gates[1]!.resolve(); expect(await second).toBe(1); expect(completions[0]).not.toHaveBeenCalled();
    gates[0]!.resolve(); expect(await first).toBe(0);
    for (const [index, receive] of completions.entries()) {
      expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [{ type: "text", text: String(index) }],
        terminal: { ok: true, value: String(index) } });
    }
  });

  it("does not attribute a nested unclaimed invocation's workers to its eligible caller", () => {
    const outer = worker(), inner = worker(), receive = vi.fn();
    const nested = { execute() { inner.on("message", () => {}); inner.emit("message", done('"inner"')); } };
    const definition = { execute() {
      Reflect.apply(nested.execute, null, ["unclaimed"]);
      outer.on("message", () => {}); outer.emit("message", done('"outer"'));
    } };
    const watch = observer(id => id === "eligible" ? receive : undefined);
    watch.watch(nested); watch.watch(definition); Reflect.apply(definition.execute, null, ["eligible"]);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [], terminal: { ok: true, value: '"outer"' } });
  });

  it("snapshots before native listener mutation while forwarding the exact message and extra arguments", () => {
    const source = worker(), message = output("observed"), extra = {}, receive = vi.fn();
    const listener = vi.fn(function (this: unknown, actual: unknown, rest: unknown) {
      expect(this).toBe(source);
      if (rest === extra) {
        expect(actual).toBe(message); message.item.text = "native mutation";
      }
    });
    const definition = { execute() {
      source.on("message", listener); source.emit("message", message, extra);
      source.emit("message", done()); source.removeListener("message", listener);
    } };
    observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
    expect(listener).toHaveBeenCalledTimes(2); expect(listener.mock.calls[0]![1]).toBe(extra);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [{ type: "text", text: "observed" }], terminal: { ok: true } });
  });

  it("quarantines a worker reused by overlapping invocation registrations", async () => {
    const source = worker(), gate = deferred<void>(), completions = [vi.fn(), vi.fn()];
    const definition = { execute() { source.on("message", () => {}); return gate.promise; } };
    observer(id => completions[Number(id)]).watch(definition);
    const first = Reflect.apply(definition.execute, null, ["0"]), second = Reflect.apply(definition.execute, null, ["1"]);
    source.emit("message", done()); gate.resolve(); await Promise.all([first, second]);
    for (const receive of completions) expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("observes real worker message delivery without adding listeners", async () => {
    const source = worker(), receive = vi.fn(), definition = { execute() {
      return new Promise<string>(resolve => {
        source.on("message", message => { if (message.type === "done") resolve("native"); });
        source.postMessage(output("thread")); source.postMessage(done("42"));
      });
    } };
    observer(() => receive).watch(definition); expect(source.listenerCount("message")).toBe(0);
    expect(await Reflect.apply(definition.execute, null, ["id"])).toBe("native");
    expect(source.listenerCount("message")).toBe(1);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [{ type: "text", text: "thread" }], terminal: { ok: true, value: "42" } });
  });

  it("preserves listener receiver, arguments, return and error identities and direct removal", () => {
    const source = worker(), receiver = {}, extra = {}, answer = {}, failure = {}, receive = vi.fn();
    const listener = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(receiver); expect(args).toEqual([done(), extra]); return answer;
    });
    // Keep the capture open while exercising the callback directly.
    const pending = deferred<void>(), asyncDefinition = { execute() { source.on("message", listener); return pending.promise; } };
    observer(() => receive).watch(asyncDefinition);
    Reflect.apply(asyncDefinition.execute, null, ["id"]);
    const raw = source.rawListeners("message")[0]!;
    expect(source.listeners("message")).toEqual([listener]);
    expect(Reflect.apply(raw, receiver, [done(), extra])).toBe(answer);
    source.removeListener("message", listener); expect(source.listenerCount("message")).toBe(0);

    const throwing = () => { throw failure; }, throwingDefinition = { execute() { source.on("message", throwing); } };
    observer(() => undefined).watch(throwingDefinition); Reflect.apply(throwingDefinition.execute, null, ["id"]);
    try { source.emit("message", output("x")); expect.unreachable(); } catch (error) { expect(error).toBe(failure); }
    source.removeListener("message", throwing); expect(source.listenerCount("message")).toBe(0);
    pending.resolve();
  });

  it("leaves once wrappers, non-message events, borrowed EventEmitter calls and unscoped on untouched", () => {
    const source = worker(), emitter = new EventEmitter(), once = vi.fn(), other = vi.fn(), outside = vi.fn(), receive = vi.fn();
    const definition = { execute() {
      source.once("message", once); source.on("custom", other);
      Worker.prototype.on.call(emitter as Worker, "message", other);
      expect(Object.getOwnPropertyDescriptor(source.rawListeners("message")[1]!, "listener")?.value).toBe(once);
      source.emit("message", done()); source.emit("message", done());
    } };
    observer(() => receive).watch(definition); source.on("message", outside);
    Reflect.apply(definition.execute, null, ["id"]);
    expect(once).toHaveBeenCalledTimes(1); expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(source.rawListeners("message")).toEqual([outside]); expect(source.rawListeners("custom")).toEqual([other]);
    expect(emitter.rawListeners("message")).toEqual([other]);
  });

  it("leaves inherited listener metadata and native listeners() behavior untouched", () => {
    const source = worker(), receive = vi.fn(), listener = () => {}, original = () => {};
    const prototype = Object.create(Function.prototype);
    Object.defineProperty(prototype, "listener", { value: original }); Object.setPrototypeOf(listener, prototype);
    const definition = { execute() {
      source.on("message", listener); source.emit("message", done());
    } };
    observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
    expect(source.rawListeners("message")).toEqual([listener]); expect(source.listeners("message")).toEqual([original]);
    expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
    source.removeAllListeners("message");
  });

  it("swallows tap inspection failure and registers the original listener unchanged", () => {
    const source = worker(), receive = vi.fn(), next = vi.fn();
    const listener = new Proxy(next, { getOwnPropertyDescriptor() { throw new Error(); } });
    const definition = { execute() {
      source.on("message", listener); source.emit("message", done());
    } };
    observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
    expect(source.rawListeners("message")[0]).toBe(listener); expect(next).toHaveBeenCalledTimes(1);
    expect(receive).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("does not duplicate capture for multiple direct listeners on one worker", () => {
    const source = worker(), receive = vi.fn(), first = vi.fn(), second = vi.fn();
    const definition = { execute() {
      source.on("message", first); source.on("message", second);
      source.emit("message", output("once")); source.emit("message", done());
    } };
    observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
    expect(first).toHaveBeenCalledTimes(2); expect(second).toHaveBeenCalledTimes(2);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [{ type: "text", text: "once" }], terminal: { ok: true } });
  });

  it("retires callbacks on disposal during execution and makes retained old wrappers inactive", async () => {
    const source = worker(), run = deferred<void>(), receive = vi.fn(), claim = vi.fn(() => receive);
    const original = vi.fn(() => { source.on("message", () => {}); return run.promise; });
    const definition = { execute: original }, watch = observer(claim), before = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
    watch.watch(definition); const old = definition.execute;
    const result = Reflect.apply(old, null, ["id"]); source.emit("message", output("discard"));
    watch.dispose(); watch.dispose(); source.emit("message", done()); run.resolve(); await result;
    expect(receive).not.toHaveBeenCalled(); expect(definition.execute).toBe(original);
    expect(Object.getOwnPropertyDescriptor(Worker.prototype, "on")).toEqual(before);
    expect(watch.watch(definition)).toBe(false);
    expect(Reflect.apply(old, null, ["later"])).toBe(run.promise); expect(claim).toHaveBeenCalledTimes(1);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it("closes completed captures so late messages cannot cause a second callback", () => {
    const source = worker(), receive = vi.fn(), definition = { execute() { source.on("message", () => {}); source.emit("message", done()); } };
    observer(() => receive).watch(definition); Reflect.apply(definition.execute, null, ["id"]);
    source.emit("message", output("late")); source.emit("message", done("late"));
    expect(receive).toHaveBeenCalledExactlyOnceWith({ items: [], terminal: { ok: true } });
  });

  it("does not capture async registrations after disposal or abort an actor-owned signal", async () => {
    const source = worker(), gate = deferred<void>(), receive = vi.fn(), abort = new AbortController(), listener = vi.fn();
    const definition = { async execute(_id: string, signal: AbortSignal) {
      await gate.promise; expect(signal).toBe(abort.signal);
      source.on("message", listener); source.emit("message", done()); return 8;
    } };
    const watch = observer(() => receive), before = Object.getOwnPropertyDescriptor(Worker.prototype, "on");
    watch.watch(definition); const result = definition.execute("id", abort.signal);
    watch.dispose(); gate.resolve(); expect(await result).toBe(8);
    expect(abort.signal.aborted).toBe(false); expect(receive).not.toHaveBeenCalled();
    expect(source.rawListeners("message")).toEqual([listener]);
    expect(Object.getOwnPropertyDescriptor(Worker.prototype, "on")).toEqual(before);
  });

  it("preserves foreign later execute and prototype replacements", () => {
    const definition = { execute() {} }, watch = observer(() => undefined); watch.watch(definition);
    const old = definition.execute, foreign = (...args: unknown[]) => Reflect.apply(old, null, args);
    const oldOn = Worker.prototype.on;
    const foreignOn = function (this: Worker, ...args: Parameters<Worker["on"]>) { return Reflect.apply(oldOn, this, args); };
    definition.execute = foreign; Object.defineProperty(Worker.prototype, "on", { value: foreignOn, writable: true, configurable: true });
    expect(watch.watch(definition)).toBe(false); watch.dispose();
    expect(definition.execute).toBe(foreign); expect(Worker.prototype.on).toBe(foreignOn);
  });

  it("reports a previously watched definition unavailable when a foreign owner replaces the worker tap", () => {
    const definition = { execute() {} }, watch = observer(() => undefined); watch.watch(definition);
    Object.defineProperty(Worker.prototype, "on", { value: EventEmitter.prototype.on });
    expect(watch.watch(definition)).toBe(false);
  });

  it("does not restore descriptors whose flags were changed by a foreign owner", () => {
    const definition = { execute() {} }, watch = observer(() => undefined); watch.watch(definition);
    const wrapped = definition.execute;
    Object.defineProperty(definition, "execute", { enumerable: false }); watch.dispose();
    expect(definition.execute).toBe(wrapped); expect(Object.getOwnPropertyDescriptor(definition, "execute")?.enumerable).toBe(false);
  });
});
