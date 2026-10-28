import type { Component } from "@earendil-works/pi-tui";

type NativeBody = Component & { readonly children: Component[] };
interface BodyFrame {
  readonly width: number;
  readonly rawChildren: readonly Component[];
  readonly children: Component[];
  readonly lines: string[];
  readonly top: number;
}

export function inlineNativeToolBody(host: Component, body: NativeBody): NativeBody {
  const first = body.children[0];
  const initial = first?.constructor.name === "Spacer" ? first.render(1) : undefined;
  const separator = initial?.length === 1 && initial[0] === "" ? first : undefined;
  let frame: BodyFrame | undefined;
  const matches = (children: readonly Component[]) => frame?.rawChildren.length === children.length &&
    frame.rawChildren.every((child, index) => child === children[index]);

  return {
    get children() {
      const children = body.children;
      return frame && matches(children) ? frame.children : children;
    },
    render(width) {
      const currentChildren = body.children, rawChildren = [...currentChildren];
      const native = body.render(width);
      const definition: unknown = Reflect.get(host, "toolDefinition");
      const self = typeof definition === "object" && definition !== null && Reflect.get(definition, "renderShell") === "self";
      const contentHeight: unknown = Reflect.get(host, "selfRenderHeight");
      const ownedSeparator = separator !== undefined && rawChildren[0] === separator;
      const top = ownedSeparator && native[0] === "" &&
        (!self || (typeof contentHeight === "number" && contentHeight > 0)) ? 1 : 0;
      const lines = top ? native.slice(top) : native;
      const omitChild = top > 0 || (ownedSeparator && self && contentHeight === 0);
      const children = lines.length === 0 ? [] : omitChild ? rawChildren.slice(1) : currentChildren;
      frame = {width, rawChildren, children, lines, top};
      return lines;
    },
    handleMouse(event) {
      if (!frame || frame.width !== event.width || !matches(body.children)) return {handled: true};
      return body.handleMouse?.({...event, y: event.y + frame.top, height: event.height + frame.top});
    },
    invalidate() { frame = undefined; body.invalidate(); },
  };
}
