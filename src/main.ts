import "./style.css";
import { App } from "./ui/app.ts";
import { claimSharedFiles, registerServiceWorker } from "./pwa/share.ts";

const root = document.getElementById("app");
if (!root) throw new Error("#app missing");

const app = new App(root);
await registerServiceWorker();
app.pending = await claimSharedFiles();
await app.boot();
