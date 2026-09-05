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
- **Changing your passphrase re-wraps one key.** It does not re-encrypt 700 files.
- **The backup is the real product.** OPFS is not a backup — browsers evict.
  Export streams the whole vault into a ZIP (STORE; ciphertext doesn't compress)
  and restore validates the passphrase, the manifest and the full object
  inventory *before* touching anything on disk.

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

## What works

Vault creation, passphrase unlock, auto-lock, chunked encrypted storage in OPFS,
encrypted manifest with crash-safe A/B snapshots, single and batch import with
drag-drop and paste, duplicate detection, tags, collections, notes, expiry dates,
search, image and text preview, save, share, delete, storage/quota warnings,
integrity verification, and streaming encrypted backup + restore.

## What doesn't, yet

- **PDF preview.** The browser's viewer needs `<embed>`/`<iframe>`, which
  `object-src 'none'` and `frame-src 'none'` block. The answer is self-hosted
  pdf.js, not a quietly widened CSP. Until then PDFs save and share fine.
- **WebAuthn PRF device unlock.** Designed (spec §19–22), not built. The
  passphrase is and stays the only recovery path regardless.
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
