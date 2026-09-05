import { el } from "./dom.ts";

export interface ModalHandle {
  close(): void;
  root: HTMLElement;
}

/** Centered panel over a dimmed backdrop. Esc and backdrop click both dismiss. */
export function modal(
  title: string,
  build: (handle: ModalHandle) => (Node | string | false | null | undefined)[],
  opts: { dismissible?: boolean } = {},
): ModalHandle {
  const dismissible = opts.dismissible ?? true;
  const backdrop = el("div", { class: "backdrop" });
  const panel = el("div", { class: "modal", role: "dialog", "aria-modal": "true" });

  const handle: ModalHandle = {
    root: panel,
    close() {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
    },
  };

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && dismissible) handle.close();
  }

  panel.appendChild(el("h3", { text: title }));
  for (const child of build(handle)) {
    if (child) panel.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }

  backdrop.appendChild(panel);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop && dismissible) handle.close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);

  panel.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
  return handle;
}

export function confirmModal(
  title: string,
  body: (Node | string)[],
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  opts: { danger?: boolean } = {},
): void {
  modal(title, (h) => [
    ...body,
    el("div", { class: "actions" }, [
      el("button", { class: "btn", text: "Cancel", onClick: () => h.close() }),
      el("button", {
        class: `btn ${opts.danger ? "danger" : "primary"}`,
        text: confirmLabel,
        onClick: async () => {
          h.close();
          await onConfirm();
        },
      }),
    ]),
  ]);
}
