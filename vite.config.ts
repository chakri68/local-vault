import { execSync } from "node:child_process";
import { defineConfig } from "vite";

function buildId(): string {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "dev";
  }
}

/**
 * §43. The CSP is set here for dev and must be set by the host for production
 * (§54) — a meta tag cannot carry frame-ancestors and is easy to forget.
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
].join("; ");

export default defineConfig({
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
