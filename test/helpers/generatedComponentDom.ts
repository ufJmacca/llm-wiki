import vm from "node:vm";

import ts from "typescript";

type EventListener = () => void;

type VNodeChild = VNode | VNodeChild[] | string | number | boolean | null | undefined;

type VNode = {
  type: unknown;
  props: Record<string, unknown>;
  children: VNodeChild[];
};

const Fragment = Symbol("Fragment");

export class ComponentTestElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly children: ComponentTestElement[] = [];
  parent: ComponentTestElement | null = null;
  className = "";
  href = "";
  private text = "";

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string | null) {
    this.text = value ?? "";
    this.children.splice(0, this.children.length);
  }

  append(...nodes: Array<ComponentTestElement | string | number>): void {
    for (const node of nodes) {
      const child =
        node instanceof ComponentTestElement ? node : ComponentTestElement.textNode(String(node));
      child.parent = this;
      this.children.push(child);
    }
  }

  after(node: ComponentTestElement): void {
    if (this.parent === null) {
      return;
    }

    const index = this.parent.children.indexOf(this);
    if (index === -1) {
      return;
    }

    node.parent = this.parent;
    this.parent.children.splice(index + 1, 0, node);
  }

  closest(selector: string): ComponentTestElement | null {
    let current: ComponentTestElement | null = this;
    while (current !== null) {
      if (current.matches(selector)) {
        return current;
      }
      current = current.parent;
    }
    return null;
  }

  querySelector(selector: string): ComponentTestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): ComponentTestElement[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  private descendants(): ComponentTestElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  private matches(selector: string): boolean {
    if (selector === "pre code") {
      return this.tagName === "code" && this.hasAncestor("pre");
    }

    const dataSelector = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/u);
    if (dataSelector !== null) {
      const key = dataAttributeToDatasetKey(dataSelector[1] ?? "");
      const expected = dataSelector[2];
      return Object.prototype.hasOwnProperty.call(this.dataset, key) && (expected === undefined || this.dataset[key] === expected);
    }

    return this.tagName === selector.toLowerCase();
  }

  private hasAncestor(tagName: string): boolean {
    let current = this.parent;
    while (current !== null) {
      if (current.tagName === tagName) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private static textNode(text: string): ComponentTestElement {
    const node = new ComponentTestElement("#text");
    node.textContent = text;
    return node;
  }
}

export class ComponentTestDocument {
  readonly article = new ComponentTestElement("article");
  private readonly listeners = new Map<string, EventListener[]>();

  createElement(tagName: string): ComponentTestElement {
    return new ComponentTestElement(tagName);
  }

  querySelector(selector: string): ComponentTestElement | null {
    if (selector === "article") {
      return this.article;
    }

    return this.article.querySelector(selector);
  }

  addEventListener(eventName: string, listener: EventListener): void {
    const listeners = this.listeners.get(eventName) ?? [];
    listeners.push(listener);
    this.listeners.set(eventName, listeners);
  }

  dispatchEventName(eventName: string): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener();
    }
  }
}

export function appendJsonCodeBlock(document: ComponentTestDocument, items: unknown[]): void {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = JSON.stringify(items, null, 2);
  pre.append(code);
  document.article.append(pre);
}

export function executeGeneratedClientScript(script: string, document: ComponentTestDocument): void {
  const runScript = new Function("document", "HTMLElement", script) as (
    document: ComponentTestDocument,
    HTMLElement: typeof ComponentTestElement,
  ) => void;

  runScript(document, ComponentTestElement);
}

export function extractGeneratedClientScript(component: string, variableName: string): string {
  const match = component.match(new RegExp(`^const ${variableName} = (".*")$`, "mu"));
  if (match === null || match[1] === undefined) {
    throw new Error(`Could not find generated client script ${variableName}.`);
  }

  return JSON.parse(match[1]) as string;
}

export function renderGeneratedQuartzComponent(component: string, props: Record<string, unknown>): VNodeChild {
  const transpiled = ts.transpileModule(component, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      jsxFactory: "h",
      jsxFragmentFactory: "Fragment",
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports: Record<string, unknown> = {};
  const sandbox = {
    exports,
    Fragment,
    h,
    require: (specifier: string): unknown => {
      if (specifier === "../quartz/util/path") {
        return {
          resolveRelative: (_currentSlug: string, href: string) => `/${href}`,
        };
      }

      throw new Error(`Unexpected generated component import: ${specifier}`);
    },
  };

  vm.runInNewContext(transpiled.outputText, sandbox);
  const constructor = exports.default;
  if (typeof constructor !== "function") {
    throw new Error("Generated component did not export a Quartz component constructor.");
  }

  const componentFunction = constructor();
  if (typeof componentFunction !== "function") {
    throw new Error("Generated component constructor did not return a component function.");
  }

  return componentFunction(props);
}

export function textFromVNode(node: VNodeChild): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }

  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(textFromVNode).join("");
  }

  return node.children.map(textFromVNode).join("");
}

export function linksFromVNode(node: VNodeChild): Array<{ href: string; text: string }> {
  if (node === null || node === undefined || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap(linksFromVNode);
  }

  const ownLink =
    node.type === "a" && typeof node.props.href === "string"
      ? [{ href: node.props.href, text: textFromVNode(node.children) }]
      : [];

  return [...ownLink, ...node.children.flatMap(linksFromVNode)];
}

function h(type: unknown, props: Record<string, unknown> | null, ...children: VNodeChild[]): VNodeChild {
  const flattenedChildren = flattenChildren(children);
  if (typeof type === "function") {
    return (type as (props: Record<string, unknown>) => VNodeChild)({
      ...(props ?? {}),
      children: flattenedChildren.length === 1 ? flattenedChildren[0] : flattenedChildren,
    });
  }

  return {
    type,
    props: props ?? {},
    children: flattenedChildren,
  };
}

function flattenChildren(children: VNodeChild[]): VNodeChild[] {
  return children.flatMap((child) => (Array.isArray(child) ? flattenChildren(child) : [child]));
}

function dataAttributeToDatasetKey(attribute: string): string {
  return attribute.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}
