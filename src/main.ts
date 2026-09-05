import "./style.css";
import { App } from "./ui/app.ts";
import { claimSharedFiles, registerServiceWorker } from "./pwa/share.ts";

/**
 * Clickjacking defence (§54.1).
 *
 * `frame-ancestors` is the right tool and it is in the policy, but a <meta> CSP
 * silently ignores that directive and GitHub Pages cannot send headers. So on
 * the deployed host this comparison is the only thing standing between the
 * vault and being framed by another origin, where a click on "Save decrypted"
 * could be steered by an overlay the user cannot see.
 *
 * Comparing window.self to window.top needs no cross-origin access, so it works
 * regardless of who is doing the framing.
 */
if (window.self !== window.top) {
  document.documentElement.replaceChildren(
    Object.assign(document.createElement("body"), {
      style: "background:#000;color:#ece7da;font:13px ui-monospace,monospace;padding:24px",
      textContent: "Local Vault will not run inside a frame.",
    }),
  );
  throw new Error("refusing to run framed");
}

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");

const app = new App(root);
await registerServiceWorker();
app.pending = await claimSharedFiles();
await app.boot();
