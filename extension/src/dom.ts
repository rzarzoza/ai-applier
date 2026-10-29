/**
 * DOM helpers that see into open shadow roots: web-component forms (SmartRecruiters' spl-* elements) keep their inputs,
 * labels and option lists inside them, where querySelectorAll, getElementById and contains() don't reach.
 */

/** Every element matching `selector` under `root`, including inside open shadow roots, in document order. */
export function deepQueryAll<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  const out: T[] = [];
  const visit = (r: ParentNode) => {
    for (const e of Array.from(r.querySelectorAll("*"))) {
      if (e.matches(selector)) out.push(e as T);
      if (e.shadowRoot) visit(e.shadowRoot);
    }
  };
  visit(root);
  return out;
}

/** Every open shadow root on the page (to watch them for changes). */
export function shadowRoots(root: ParentNode = document): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const visit = (r: ParentNode) => {
    for (const e of Array.from(r.querySelectorAll("*"))) {
      if (e.shadowRoot) { out.push(e.shadowRoot); visit(e.shadowRoot); }
    }
  };
  visit(root);
  return out;
}

/** The parent, stepping out of a shadow root to its host. */
export function composedParent(n: Node): Element | null {
  if (n.parentElement) return n.parentElement;
  const r = n.getRootNode();
  return r instanceof ShadowRoot ? r.host : null;
}

/** Whether `node` is `ancestor` or inside it, through shadow roots. */
export function composedContains(ancestor: Element, node: Node): boolean {
  for (let n: Node | null = node; n; n = composedParent(n)) if (n === ancestor) return true;
  return false;
}

/** The element with this id in `ctx`'s own root (shadow root or document), else in the document. */
export function byIdNear(ctx: Node, id: string): HTMLElement | null {
  const r = ctx.getRootNode() as Document | ShadowRoot;
  return (r.getElementById?.(id) as HTMLElement | null) ?? document.getElementById(id);
}

/** The light-DOM element standing for `el` (itself, or the outermost shadow host it lives in). */
export function lightHost(el: Element): Element {
  let n = el;
  for (let r = n.getRootNode(); r instanceof ShadowRoot; r = n.getRootNode()) n = r.host;
  return n;
}
