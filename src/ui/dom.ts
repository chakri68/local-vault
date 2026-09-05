type Props = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

/** Minimal element builder. No framework, no virtual DOM, no ceremony. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = String(v);
    // CSP governs the style *attribute*, not CSSOM. Going through cssText lets
    // style-src stay at 'self' with no 'unsafe-inline' (§43).
    else if (k === "style") node.style.cssText = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "value" || k === "checked" || k === "disabled" || k === "hidden") {
      (node as unknown as Props)[k] = v;
    } else node.setAttribute(k, String(v));
  }
  append(node, children);
  // §58: a `.field` wires its own label to its own control, so every call site
  // gets a real label association without repeating an id dance 22 times.
  if (node.classList.contains("field")) wireField(node);
  return node;
}

let fieldSeq = 0;

function wireField(node: HTMLElement): void {
  const label = node.querySelector("label");
  const control = node.querySelector<HTMLElement>("input, select, textarea");
  if (!label || !control) return;
  if (!control.id) control.id = `lv-f${++fieldSeq}`;
  if (!control.getAttribute("name")) control.setAttribute("name", control.id);
  label.setAttribute("for", control.id);
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  append(node, children);
}

/** Progress bars, without touching the style attribute. */
export function setWidth(node: Element | null, percent: number): void {
  if (node instanceof HTMLElement) node.style.width = `${percent}%`;
}
