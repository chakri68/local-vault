#!/usr/bin/env node
/**
 * Vendor the Amber Phosphor design tokens into this repo.
 *
 * Every other chakri.me site links https://theme.chakri.me/tokens.css straight
 * from its <head>. The vault cannot: §43 pins `style-src 'self'` and
 * `connect-src 'none'`, and §44 asks for zero application-initiated network
 * requests, so a cross-origin stylesheet would be blocked by our own policy —
 * correctly. Pulling the tokens in at authoring time keeps the single source of
 * truth without putting the theme on the network path of a locked vault.
 *
 * The output is COMMITTED, not gitignored: the build must produce the same CSS
 * with no network at all. Re-run this when the theme moves, and review the diff
 * like any other dependency bump.
 *
 *   npm run pull-theme                                        # the pinned version below
 *   THEME_URL=https://theme.chakri.me/tokens.css npm run pull-theme   # whatever is promoted
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Pinned, not floating: a theme edit reaching the vault should be a commit here,
// so the CSS that ships is the CSS that was reviewed. Bump deliberately.
const THEME_VERSION = "1.0.0";

const url = process.env.THEME_URL ?? `https://theme.chakri.me/${THEME_VERSION}/tokens.css`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.THEME_OUT ?? path.join(root, "src", "theme-tokens.css");

const res = await fetch(url);
if (!res.ok) {
  console.error(`pull-theme: ${url} -> ${res.status} ${res.statusText}`);
  process.exit(1);
}

const css = (await res.text()).trim();
const header = `/* GENERATED — do not edit. Run \`npm run pull-theme\` instead.
   Source: ${url}
   Why vendored rather than linked: see scripts/pull-theme.mjs. */\n`;

await writeFile(out, `${header}${css}\n`);
console.log(`pull-theme: ${url} -> ${path.relative(root, out)} (${css.length} bytes)`);
