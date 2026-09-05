import { el } from "../dom.ts";

/**
 * §49.1. Reached by failing a capability probe, never by a user-agent match.
 * Safari lands here because it has no createWritable(), which is the whole
 * mechanism behind §4's scope decision.
 */
export function renderUnsupported(missing: string[]): HTMLElement {
  return el("div", { class: "center" }, [
    el("div", { class: "panel" }, [
      el("h1", { text: "LOCAL VAULT" }),
      el("div", { class: "notice error" }, [
        el("div", { text: "This browser can't run Local Vault." }),
      ]),
      el("div", {}, [
        el("h2", { text: "Missing" }),
        el(
          "ul",
          { class: "muted", style: "margin:6px 0 0;padding-left:18px;font-size:12px" },
          missing.map((m) => el("li", { text: m })),
        ),
      ]),
      el("p", {
        class: "hint",
        text:
          "Local Vault needs streaming writes to the Origin Private File System to store " +
          "encrypted files without buffering them in memory. Chromium browsers — Chrome, " +
          "Edge, Brave — support this on desktop and Android.",
      }),
      el("p", {
        class: "hint",
        text:
          "Nothing was created on this device, and no vault data was read.",
      }),
    ]),
  ]);
}
