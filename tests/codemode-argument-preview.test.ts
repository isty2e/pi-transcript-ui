import { expect, it } from "vitest";
import { argumentPreview } from "../src/codemode/argument-preview.js";

it("preserves complete JSON values, including literal ellipses and escaped strings", () => {
  const args = {path: 'src/"東\\file...ts', offset: 0, limit: 12, extra: [null, true, {path: "nested"}]};
  expect(argumentPreview(JSON.stringify(args))).toEqual({args, complete: true, source: "preview"});
  expect(argumentPreview('{"path":"literal..."}')?.args).toEqual({path: "literal..."});
});

it("decodes every producer cut without completing a field or using a nested path", () => {
  const args = {path: 'src/"東\\file.ts', offset: 123, limit: 2, extra: [{path: "not-root"}, false, null]};
  const text = JSON.stringify(args), pathEnd = text.indexOf(',"offset"'), offsetEnd = text.indexOf(',"limit"');
  for (let cut = 0; cut < text.length; cut++) {
    const decoded = argumentPreview(text.slice(0, cut) + "...");
    if (cut === 0) { expect(decoded).toBeUndefined(); continue; }
    expect(decoded?.complete, `cut ${cut}`).toBe(false);
    const fields = decoded!.args as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) expect(value, `cut ${cut}, ${key}`).toEqual(args[key as keyof typeof args]);
    expect(Object.hasOwn(fields, "path"), `path cut ${cut}`).toBe(cut >= pathEnd);
    expect(Object.hasOwn(fields, "offset"), `number cut ${cut}`).toBe(cut > offsetEnd);
  }
  expect(argumentPreview('{"extra":{"path":"hidden"},"path":"unfinished...')?.args).toEqual({extra: {path: "hidden"}});
});

it.each(['{"path":"abc...', '{"path":"a\\...', '{"path":"a\\u12...'])
  ("does not turn an unfinished string into a target: %s", preview => {
    expect(argumentPreview(preview)?.args).toEqual({});
  });

it("requires a numeric boundary but accepts a complete fixed literal", () => {
  expect(argumentPreview('{"limit":12...')?.args).toEqual({});
  expect(argumentPreview('{"limit":12,...')?.args).toEqual({limit: 12});
  expect(argumentPreview('{"flag":true...')?.args).toEqual({flag: true});
  expect(argumentPreview('{"flag":tru...')?.args).toEqual({});
});

it.each(['{"path":"a",}', '{"path":"a","path":"b"}', '{"x":{"k":1,"k":2}}',
  '{"path":"a"}...', '{"path":"a"}tail...', '{"limit":01...', '{"limit":1.e...',
  '{"x":[1,]}...', '{"path":"bad\\q...', '{"path":"raw\n...', 'not JSON...', '[{"path":"a"}]'])
  ("rejects malformed, duplicated or non-object input without repairing it: %s", preview => {
    expect(argumentPreview(preview)).toBeUndefined();
  });

it("treats prototype-like JSON keys as data without polluting another request", () => {
  expect(argumentPreview('{"__proto__":{"path":"polluted"},"path":"actual"}')?.args)
    .toEqual(JSON.parse('{"__proto__":{"path":"polluted"},"path":"actual"}'));
  expect(argumentPreview('{}')?.args).toEqual({});
});
