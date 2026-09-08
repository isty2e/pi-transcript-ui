import { vi } from "vitest";
import { Container } from "@earendil-works/pi-tui";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export type NativeToolDefinition = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]> & { name: string };

export function nativeTranscript() {
  const root = new Container();
  const chat = new Container();
  root.addChild(chat);
  return { root, chat };
}

interface NativeToolInput {
  name: string;
  id: string;
  args: unknown;
  definition: ConstructorParameters<typeof ToolExecutionComponent>[4];
}

export function nativeTool({ name, id, args, definition }: NativeToolInput) {
  return new ToolExecutionComponent(name, id, args, {}, definition, { requestRender: vi.fn() } as never, "/tmp");
}
