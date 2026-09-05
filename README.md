# Local Vault

Every few months I need my passport scan, or last August's salary slip, or that
one certificate, and every time it's a dig through Drive folders named after
whatever I was thinking in 2023. The premise here is that important files should
be findable by *what they are*, not by where you filed them — and that a pile of
identity documents shouldn't be sitting in someone else's cloud to make that work.

So: a PWA that keeps encrypted documents in the browser's Origin Private File
System, on your device, with no backend, no account, and no network requests at
runtime. You search for "passport photo" and it's there.

Full design in [`spec.md`](spec.md). The UI follows [`ui_theme.md`](ui_theme.md).

## How it actually works

```
passphrase ──Argon2id──> KEK ──wraps──> Master Key ──wraps──> per-file keys
                                             │                     │
                                        manifest.enc          AES-256-GCM
                                        (all metadata)         in 1 MiB chunks
                                             │                     │
                                             └────── OPFS ─────────┘
```

- **The master key never touches the main thread.** It's a non-extractable
  `CryptoKey` living inside one worker that owns all crypto and all OPFS I/O. The
  UI talks to it over a narrow typed RPC and can only ask, never reach.
- **Every file gets a fresh 256-bit key**, wrapped by the master key. Chunks are
  AES-256-GCM with a counter nonce — safe because the file key is used for
  exactly one file — and each chunk's AAD binds vault id, file id, chunk index
  *and total chunk count*, so truncation fails authentication on the first read
  instead of silently succeeding at the end.
- **Metadata is ciphertext too.** Anyone poking at OPFS sees UUIDs and noise, not
  `passport-scan.pdf`. The manifest is written with alternating snapshots and an
  `active` pointer that only moves after the new snapshot reads back and decrypts.
  Mutations are serialised, because two of them racing on that pointer is exactly
  how a change reports success and then vanishes.
- **Storage is generational.** The whole vault lives under a directory named by a
  `/current` pointer. A restore builds a *new* generation and flips the pointer
  last, so until one small write lands, your existing vault is untouched. Same
  trick as the manifest slots, one level up.
- **Locking cancels work in flight.** A read that already unwrapped a file key
  doesn't care that you cleared the master key — so every lock bumps an epoch,
  and long operations check it between chunks and bail.
- **Changing your passphrase re-wraps one key.** It does not re-encrypt 700 files.
- **Device unlock is a second wrapper, never a replacement.** WebAuthn PRF gives a
  stable secret bound to the credential; that derives a KEK which wraps the same
  master key. No PRF means no secret to derive, so the feature is refused outright
  rather than downgraded into something that only *looks* like biometric unlock.
  The passphrase wrapper always exists, so a lost phone costs convenience, not
  the vault.
- **The backup is the real product.** OPFS is not a backup — browsers evict.
  Export streams the whole vault into a ZIP (STORE; ciphertext doesn't compress).
  Restore checks the passphrase and manifest, writes into a fresh generation,
  then **authenticates every chunk of every object off disk** before flipping the
  pointer. Checking that an archive contains a file of the right *name* is not
  checking it — a corrupt object would otherwise restore cleanly and surface
  months later, long after the healthy vault it replaced was gone.

## Chromium only, on purpose

Safari has no `createWritable()` on OPFS and no Web Share Target — the first
means a second, structurally different storage backend, the second means the most
important import path doesn't exist. Not worth it for v1.

There is no user-agent string anywhere in the code. Unsupported browsers fail a
capability probe at boot and get told so plainly, and Safari falls out of that on
its own.

## Running it

```sh
npm install
npm run dev      # or: npm run build && npm run preview
```

The dev and preview servers set the production CSP, so if something would break
under `connect-src 'none'` you find out immediately rather than at deploy.

`script-src` needs `'wasm-unsafe-eval'` (Argon2 is WASM). `connect-src` gets to
stay at `'none'` because hash-wasm inlines its binary as base64 — keep that
property if you ever swap the KDF library.

## Deploying

Pushes to `main` build and publish to **vault.chakri.me** via GitHub Pages
(`.github/workflows/deploy.yml`). Before the first deploy you need two things
that live outside the repo:

1. In the repo: **Settings → Pages → Source = GitHub Actions**.
2. In Cloudflare DNS for `chakri.me`: a `CNAME` record `vault` →
   `chakri68.github.io`, **DNS only** (grey cloud — an orange cloud in front of
   Pages breaks its certificate provisioning until Pages has issued one).

That hostname is a one-way door. OPFS is origin-scoped and WebAuthn credentials
are RP-scoped, so moving it later orphans every existing vault and every enrolled
device. There's no migration path — the new origin can't read the old one's
storage.

### The header problem

GitHub Pages serves static files with fixed headers and no way to add custom
ones, so the CSP travels in a `<meta>` tag injected at build time instead. That
costs three things: `frame-ancestors` (silently ignored in `meta`),
`X-Content-Type-Options`, and `Permissions-Policy`.

The first one actually matters — a vault whose "Save decrypted file" button can
be driven by an invisible overlay is a real problem — so `main.ts` refuses to
boot inside a frame at all. The other two are residual risk: small, since Pages
sets correct MIME types and the app requests no permissions, but not zero. §54.1
has the full table.

Moving to a host that can send headers (Cloudflare Pages, Netlify — both take a
`_headers` file) closes all three and deletes the frame check. The CSP is defined
once in `vite.config.ts` and already served as a real header in dev, so it's a
config change rather than a rewrite.

CI refuses to publish a build whose CSP meta tag went missing, whose CNAME
doesn't say `vault.chakri.me`, or whose HTML references an off-origin URL.

## What works

Vault creation, passphrase unlock, auto-lock, chunked encrypted storage in OPFS,
encrypted manifest with crash-safe A/B snapshots, single and batch import with
drag-drop and paste, duplicate detection, tags, collections, notes, expiry dates,
search, image, text and PDF preview, save, share, delete, storage/quota warnings,
integrity verification, streaming encrypted backup + restore, and WebAuthn PRF
device unlock.

## Reviews

`codex exec` reviewed the first two commits and found seven real defects,
including two criticals in restore — it deleted the live vault before
authenticating a single object, and the replacement wasn't staged or
rollback-safe. Both are fixed above; the generational layout exists because of
that review. Details in the commit log.

## What doesn't, yet

- **The Android share target is untested on a real device.** The service worker
  side is written and the handoff is memory-only by design — shared files are
  never staged as plaintext, so an abandoned import evaporates instead of leaking.
  Whether `request.formData()` streams a 300 MB multipart body or buffers it into
  the heap is the one thing worth checking on real hardware before trusting it.
- Encrypted trash, OCR, version history, multiple vaults. See spec §60.

## Not a backup service

If you clear site data, the vault is gone. If you lose the passphrase, the vault
is gone — including its backups. Both of these are the point, but they're also
genuinely how you lose your documents, so export a backup somewhere real.
