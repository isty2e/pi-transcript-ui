import { afterEach, expect, it, vi } from "vitest";
import { InteractiveMode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NativeModeCleanupError, observeNativeMode, type NativeModeObservation } from "../src/native-mode.js";

const prototype = InteractiveMode.prototype;
const original = Object.getOwnPropertyDescriptor(prototype, "renderSessionEntries")!;
const observations: NativeModeObservation[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  try { for (const observation of observations.splice(0).reverse()) observation.dispose(); }
  finally { Object.defineProperty(prototype, "renderSessionEntries", original); }
});
const api = { getFlag: () => undefined } as unknown as ExtensionAPI;
const mode = (handler: unknown, resolve = vi.fn(() => [{ handler }])) => ({ session: { extensionRunner: { resolveRegisteredCommands: resolve } } });
function call(value: unknown): unknown {
  const method = Object.getOwnPropertyDescriptor(prototype, "renderSessionEntries")!.value as (...args: unknown[]) => unknown;
  return Reflect.apply(method, value, [[]]);
}
function observe(handler: unknown, receive: Parameters<typeof observeNativeMode>[2], owner = api): NativeModeObservation {
  const observation = observeNativeMode(owner, handler, receive); observations.push(observation); return observation;
}

it("selects the matching command witness and does no command resolution after capture", () => {
  const native = vi.fn(() => "NATIVE");
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: native });
  const first = async () => {}, second = async () => {}, receiveA = vi.fn(() => undefined), receiveB = vi.fn(() => undefined);
  const a = observe(first, receiveA), b = observe(second, receiveB);
  const one = mode(first), two = mode(second);
  expect(call(two)).toBe("NATIVE"); expect(b.mode).toBe(two); expect(a.mode).toBeUndefined();
  expect(call(one)).toBe("NATIVE"); expect(a.mode).toBe(one);
  const before = one.session.extensionRunner.resolveRegisteredCommands.mock.calls.length;
  for (let i = 0; i < 100; i++) expect(call(one)).toBe("NATIVE");
  expect(one.session.extensionRunner.resolveRegisteredCommands).toHaveBeenCalledTimes(before);
  expect(receiveA).toHaveBeenCalledTimes(1); expect(receiveB).toHaveBeenCalledTimes(1);
});

it("keeps an ambiguous or invalidated extension native and does not revive retired observers", () => {
  const native = vi.fn(() => "NATIVE");
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: native });
  const handler = async () => {}, receive = vi.fn(() => undefined), value = mode(handler);
  const a = observe(handler, receive), b = observe(handler, receive);
  expect(call(value)).toBe("NATIVE"); expect(receive).not.toHaveBeenCalled();
  a.dispose(); b.dispose();
  let active = true;
  const invalidated = { getFlag() { if (!active) throw new Error("Owned inactive API"); } } as unknown as ExtensionAPI;
  const c = observe(handler, receive, invalidated);
  const held = Object.getOwnPropertyDescriptor(prototype, "renderSessionEntries")!.value as (...args: unknown[]) => unknown;
  active = false;
  expect(call(value)).toBe("NATIVE"); expect(c.mode).toBeUndefined();
  c.dispose(); expect(Reflect.apply(held, value, [[]])).toBe("NATIVE");
  expect(receive).not.toHaveBeenCalled();
});

it("preserves the native error exactly once when preparation fails", () => {
  const sentinel = new Error("Owned native failure"), native = vi.fn(() => { throw sentinel; });
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: native });
  const handler = async () => {}, observation = observe(handler, () => { throw new Error("Owned setup failure"); });
  expect(() => call(mode(handler))).toThrow(sentinel);
  expect(native).toHaveBeenCalledTimes(1); expect(observation.error).toBeInstanceOf(Error);
});

it("preserves foreign forwarding replacements during retirement", () => {
  const native = vi.fn(() => "NATIVE"), handler = async () => {};
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: native });
  const observation = observe(handler, () => undefined);
  const observed = Object.getOwnPropertyDescriptor(prototype, "renderSessionEntries")!.value as (...args: unknown[]) => unknown;
  const foreign = vi.fn(function (this: unknown, ...args: unknown[]) { return Reflect.apply(observed, this, args); });
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: foreign });
  expect(call(mode(handler))).toBe("NATIVE");
  observation.dispose();
  expect(call(mode(handler))).toBe("NATIVE");
  expect(foreign).toHaveBeenCalledTimes(2); expect(native).toHaveBeenCalledTimes(2);
});

it("retains cleanup ownership after failed lease release and permits retry before replacement", () => {
  const native = vi.fn(() => "NATIVE"), handler = async () => {};
  Object.defineProperty(prototype, "renderSessionEntries", { ...original, value: native });
  const observation = observe(handler, () => undefined), remove = Reflect.deleteProperty;
  vi.spyOn(Reflect, "deleteProperty").mockImplementation((object, key) =>
    object === prototype && key === Symbol.for("pi-transcript-ui.native-mode-observer.v1") ? false : remove(object, key));
  expect(call(mode(handler))).toBe("NATIVE");
  expect(observation.error).toBeInstanceOf(NativeModeCleanupError);
  expect(() => observeNativeMode(api, handler, () => undefined)).toThrow(NativeModeCleanupError);
  vi.restoreAllMocks(); observation.dispose();
  const replacement = observe(handler, () => undefined), value = mode(handler);
  expect(call(value)).toBe("NATIVE"); expect(replacement.mode).toBe(value);
});
