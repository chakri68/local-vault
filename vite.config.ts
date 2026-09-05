import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

/**
 * §43. Served as a header in dev/preview, and injected as a <meta> tag into the
 * production build — because GitHub Pages cannot send custom headers at all
 * (§54.1). The two are the same policy, with one unavoidable gap: `meta`
 * silently ignores frame-ancestors, so clickjacking is defended in main.ts
 * instead.
 *
 *   'wasm-unsafe-eval'  Argon2id is WASM; script-src 'self' alone blocks
 *                       WebAssembly compilation in Chromium.
 *   connect-src 'none'  survives because hash-wasm embeds its binary as base64,
 *                       so nothing is ever fetched at runtime.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "connect-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  // Honoured as a header; ignored in <meta>. See the frame check in main.ts.
  "frame-ancestors 'none'",
].join("; ");

/**
 * GitHub Pages serves static files with fixed headers, so the policy has to
 * travel inside the document. head-prepend matters: a CSP meta tag only governs
 * what the parser sees *after* it.
 */
function cspMeta(): Plugin {
  return {
    name: "local-vault:csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      const marker = '<meta charset="UTF-8" />';
      if (!html.includes(marker)) {
        // Failing the build beats shipping a vault with no policy at all.
        throw new Error("cannot place the CSP meta tag: charset marker missing from index.html");
      }
      const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;
      return html.replace(marker, `${marker}\n    ${tag}`);
    },
  };
}

export default defineConfig({
  plugins: [cspMeta()],
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    target: "es2023",
    // Immutable hashed assets (§42, §54).
    assetsInlineLimit: 0,
  },
  server: {
    headers: {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
  preview: {
    headers: {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
});
