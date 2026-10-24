import type { Component } from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

export function withAccessorChildren<T extends Component & { children: Component[] }>(component: T): () => Component[] {
  const backing = new WeakMap<T, Component[]>([[component, component.children]]);
  const prototype = Object.create(Object.getPrototypeOf(component)) as object;
  Object.defineProperty(prototype, "children", {
    configurable: true,
    get(this: T): Component[] {
      const children = backing.get(this);
      if (!children) throw new TypeError("Wrong native children receiver");
      return children;
    },
    set(this: T, children: Component[]) {
      if (!backing.has(this)) throw new TypeError("Wrong native children receiver");
      backing.set(this, children);
    },
  });
  if (!Reflect.deleteProperty(component, "children")) throw new TypeError("Cannot prepare accessor fixture");
  Object.setPrototypeOf(component, prototype);
  return () => backing.get(component)!;
}

export function restorationFault(component: ToolExecutionComponent, failInstall = false, failRestore = true) {
  let armed = false;
  const installError = new Error("controlled installation failure");
  const proxy = new Proxy(component, {
    defineProperty(target, key, descriptor) {
      if (failInstall && key === "updateDisplay") {
        armed = true;
        throw installError;
      }
      return Reflect.defineProperty(target, key, descriptor);
    },
    deleteProperty(target, key) {
      return armed && failRestore && key === "render" ? false : Reflect.deleteProperty(target, key);
    },
  });
  return { proxy, arm: () => { armed = true; } };
}
