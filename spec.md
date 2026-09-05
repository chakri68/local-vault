# Local Vault — `spec.md`

## 1. Overview

**Local Vault** is a client-side-only Progressive Web App (PWA) for securely storing small but important personal files such as:

- Passport-size photos
- ID scans
- Passport / visa scans
- Salary slips
- Tax documents
- Certificates
- Resume versions
- Receipts
- Insurance documents
- Employment documents
- Frequently reused PDFs and images

The app stores encrypted files locally using the browser's **Origin Private File System (OPFS)**.

There is **no application backend, no account system, no cloud database, and no server-side file storage**.

The core product idea is:

> Important files should be retrievable by what they are, not by remembering where they were saved.

The user should be able to search for `"passport photo"`, `"August salary slip"`, `"PAN card"`, etc. instead of navigating traditional folders.

---

# 2. Core Principles

1. **Local-first**
   - The vault must work entirely offline after the PWA is installed.
   - Files are stored in OPFS on the current device/browser profile.
   - No document contents or metadata leave the device unless the user explicitly exports or shares them.

2. **Encrypted by default**
   - OPFS is treated as a storage primitive, not as the security boundary.
   - Every stored file is encrypted before being written.
   - Sensitive metadata such as filenames, tags, notes, categories, and document dates is also encrypted.

3. **No silent deletion by the application**
   - The application must never automatically purge user vault files to reclaim space.
   - Cached application assets may be replaced or removed, but vault objects may not.

4. **Backups are first-class**
   - OPFS is not considered a backup.
   - The app must make creating an encrypted portable backup easy.
   - The backup must be sufficient to fully restore the vault after:
     - reinstalling the PWA;
     - clearing browser storage;
     - changing phones/computers;
     - switching supported browsers.

5. **Offline-capable**
   - Once installed, normal vault operations must not depend on network availability.

6. **Zero runtime third-party requests**
   - No analytics.
   - No telemetry.
   - No remote fonts.
   - No CDN-loaded JavaScript.
   - No remote OCR APIs.
   - No external image assets.
   - All dependencies required to unlock the vault must ship with the application.

---

# 3. Non-Goals

The first version is **not**:

- Google Drive replacement
- Cross-device real-time sync
- Multi-user collaboration
- A file hosting service
- A document-sharing server
- A password manager
- A cloud backup provider
- An AI document-processing service

Cloud storage may be used only as a destination for a user-created **encrypted backup archive**.

---

# 4. Target Platforms

V1 targets Chromium only:

- Android + Chromium-based browser installed as a PWA
- Desktop Chromium (Chrome, Edge, Brave, ...)

**Safari and iOS are out of scope for V1.** Two hard blockers, not preferences:

- Safari does not implement `FileSystemFileHandle.createWritable()`. Every OPFS write
  would have to go through `createSyncAccessHandle()`, which is synchronous and
  dedicated-worker-only - a second, structurally different storage backend to build
  and maintain.
- Safari has no Web Share Target, so the single most important import path does not
  exist there at all.

Firefox is untested and unsupported in V1. It has OPFS and `createWritable()`, so it
may well work; nothing is done to guarantee that it does.

The application must still **feature-detect** rather than sniff user agents. No browser
name appears anywhere in the code. See SS49.1 - an environment missing a required
capability gets an explicit unsupported screen at boot, and Safari falls out of that
check on its own without ever being named.

---

# 5. Receiving Native Shares

## Android

On supported Chromium-based Android browsers, the installed PWA registers itself as a
native share target using the Web Share Target API.

```text
Gmail / WhatsApp / Files / Photos
              |
            Share
              |
          Local Vault
              |
       Import confirmation
              |
          Encrypt + Save
```

This is a core feature. See SS16 for the receiver design.

## Desktop Chromium

No OS share-sheet integration worth relying on. Import is:

- File picker (single and multi)
- Drag and drop
- Paste

## iOS

Out of scope (SS4). Safari does not support Web Share Target, and the UI must never
claim that native Share -> Local Vault works.

If iOS becomes a hard requirement later it needs a native wrapper - Capacitor plus an
iOS Share Extension - which is no longer a browser-only implementation. Outside V1.

---

# 6. High-Level Architecture

```text
                         ┌──────────────────────┐
                         │   UI  (vanilla DOM)  │
                         └──────────┬───────────┘
                                    │
             ┌──────────────────────┼───────────────────────┐
             │                      │                       │
             ▼                      ▼                       ▼
      Vault Metadata          Vault Service          Import Service
             │                      │                       │
             └──────────────┬───────┘                       │
                            ▼                               │
                    Crypto Worker ◄─────────────────────────┘
                            │
                            ▼
                     Encrypted Objects
                            │
                            ▼
                           OPFS

Additional browser integrations:

Service Worker
├── Offline application shell
├── PWA lifecycle
└── Android Web Share Target receiver

Storage Manager
├── persistence status
├── quota estimate
└── storage warnings

WebAuthn
└── optional PRF-backed device unlock

Backup Worker
├── encrypted ZIP export
└── encrypted ZIP restore
```

---

# 7. Proposed Stack

Baseline:

- **TypeScript**
- **Vanilla DOM - no UI framework.** The security-sensitive code lives outside the view
  layer by design, the UI is a list, a sheet and a settings page, and every dependency
  not added is one that does not have to be audited under SS54.
- **Vite**
- **npm**
- Hand-written Service Worker, no Workbox runtime - a custom `/share-target` handler is
  required anyway.
- Web Crypto API for AES-256-GCM and all key wrapping.
- `hash-wasm` for Argon2id. Its WASM is embedded in the JS as base64, so there is no
  separate `.wasm` fetch and `connect-src` can stay at `'none'` (SS43).
- `@zip.js/zip.js` for streaming backup export/import. STORE only - ciphertext does not
  compress, so deflate would burn CPU for nothing.
- OPFS for encrypted file storage.
- A single Web Worker owning all crypto and all OPFS I/O.

Security-sensitive code is isolated from the view layer by **process boundary**, not
merely by module boundary: the master key never exists on the main thread. It is a
non-extractable `CryptoKey` held inside the vault worker, and the UI reaches it only
through a narrow typed RPC.

Suggested module boundaries:

```text
src/
├── main.ts                  boot: capability gate, then mount
├── style.css                amber terminal theme (see ui_theme.md)
├── platform/
│   ├── capabilities.ts      feature detection + boot gate (§49)
│   └── storage.ts           persist / persisted / estimate + warnings
├── vault/
│   ├── types.ts             header, manifest, item shapes + format versions
│   ├── crypto/
│   │   ├── argon2.ts        Argon2id KDF (hash-wasm)
│   │   ├── keys.ts          master key generate / wrap / unwrap
│   │   └── stream.ts        chunked AES-256-GCM encrypt + decrypt
│   ├── opfs.ts              OPFS paths, atomic object write, temp sweep
│   ├── manifest.ts          encrypted A/B snapshots + active pointer
│   ├── backup.ts            streaming ZIP export / restore
│   └── vault.ts             state machine, owns the master key
├── worker/
│   ├── vault.worker.ts      the only place crypto and OPFS happen
│   └── rpc.ts               typed request/response contract
├── ui/
│   ├── screens/             unsupported, first-run, unlock, browse, settings
│   └── components/          sheet, item row, chip, progress, notice
└── pwa/
    ├── service-worker.ts    app shell cache + POST /share-target
    └── share.ts             page-side token claim of shared files
```

---

# 8. Vault Lifecycle

## 8.1 First Run

On first launch:

1. Show a short explanation:
   - Files remain on this device.
   - Everything is encrypted locally.
   - Clearing site/app storage may destroy the local copy.
   - Backups are strongly recommended.

2. Ask the user to create a vault passphrase.

3. Generate:
   - random Vault ID;
   - random 256-bit Master Key;
   - random KDF salt.

4. Derive a Key Encryption Key (KEK) from the passphrase using Argon2id.

5. Encrypt/wrap the Master Key with the KEK.

6. Store the wrapped Master Key and non-sensitive cryptographic parameters.

7. Request persistent browser storage.

8. Show whether persistent storage was actually granted.

9. Offer optional device biometric/passkey unlock.

10. Open the empty vault.

---

# 9. Encryption Architecture

## 9.1 Master Key

Generate a cryptographically random 256-bit Master Key using Web Crypto.

```text
MasterKey = random(256 bits)
```

The Master Key must never be persisted unencrypted.

---

## 9.2 Passphrase Key

The user's passphrase is processed through Argon2id.

Conceptually:

```text
passphrase
    │
    ▼
Argon2id(passphrase, salt, parameters)
    │
    ▼
Key Encryption Key
```

The KDF parameters must be versioned and stored in the vault header.

They should be calibrated for modern mobile hardware rather than hardcoded forever.

The target should be sufficiently expensive to make offline guessing costly while keeping normal unlock time reasonable.

---

## 9.3 Wrapped Master Key

The KEK encrypts the Master Key.

```text
KEK
 │
 ▼
Encrypt(MasterKey)
 │
 ▼
wrappedMasterKey
```

Changing the vault passphrase only requires deriving a new KEK and re-wrapping the Master Key.

It must **not** require re-encrypting every stored file.

---

## 9.4 Per-File Keys

Every file receives a fresh random 256-bit File Key.

```text
File
 │
 ├── random FileKey
 │
 ├── encrypt file using FileKey
 │
 └── encrypt/wrap FileKey using MasterKey
```

Compromise or accidental reuse of one file key must not affect other objects.

---

## 9.5 File Encryption

Use an authenticated encryption mode available through Web Crypto, such as AES-256-GCM.

Large files must be encrypted in chunks rather than reading the entire file into RAM.

Example conceptual layout:

```text
Encrypted File Object
├── format version
├── file ID
├── encrypted/wrapped File Key
├── chunk size
├── chunk 0
├── chunk 1
├── chunk 2
└── ...
```

### Nonce construction (normative)

The File Key is freshly generated per file and used for exactly one file, so a
**deterministic counter** is safe and reuse is structurally impossible. Random nonces
are not used: at 96 bits they invite birthday-bound reasoning in exchange for nothing.

```text
nonce = 12 bytes
  bytes 0..3   0x00 0x00 0x00 0x00
  bytes 4..11  chunk index, uint64 big-endian, starting at 0
```

Never construct a nonce any other way, and never reuse a File Key across files. Writing
this down is the point - left as "must be unique", someone eventually improves it into
a random-nonce scheme.

### Associated data (normative)

Every chunk's AAD binds it to its position and its container:

```text
AAD = objectFormatVersion  uint8
    + vaultId              16 bytes
    + fileId               16 bytes
    + chunkIndex           uint64 big-endian
    + totalChunks          uint64 big-endian
```

`totalChunks` is what makes truncation detectable (SS35). GCM tags prove each chunk is
intact; they do not prove chunk 400 was meant to be the last one. Binding the expected
total into every chunk means a truncated object fails authentication on the *first*
chunk read rather than silently succeeding to the end.

---

# 10. Metadata Encryption

Sensitive metadata must not be stored in plaintext.

Encrypted fields include:

- Display filename
- Original filename
- Tags
- Notes
- Category
- Document date
- Expiry date
- Employer / issuer
- MIME-derived descriptions
- Search tokens
- User-defined fields

A person inspecting browser storage should see opaque IDs and ciphertext rather than:

```text
salary-slip-even-healthcare-august-2026.pdf
passport-scan.pdf
pan-card.jpg
```

---

# 11. OPFS Layout

OPFS paths must intentionally reveal as little as possible.

Storage is organised into **generations**, so that replacing a vault is atomic
(SS33, SS34):

```text
/current                  text: the name of the live generation
/vault/                   legacy generation, from before generations existed
/g-<uuid>/                a generation
    header.json
    manifest/
      active
      manifest-a.enc
      manifest-b.enc
    objects/
      019ab45d...
      019ab46e...
    temp/
```

A restore writes an entirely new generation, verifies it end to end, and only
then rewrites `/current`. Until that one small write lands the existing vault is
untouched and still live. This is the same write-verify-flip trick as the
manifest A/B slots (SS12), applied one level up.

Anything not named by `/current` is debris - a superseded vault, or a generation
from a restore that failed - and is safe to collect precisely because nothing
references it.

A pre-generation vault is adopted by *naming* it (`/current` = `vault`), never by
copying it.

`header.json` may contain only non-sensitive information required to unlock/restore the vault, such as:

- format version
- Vault ID
- KDF type
- KDF salt
- KDF parameters
- wrapped Master Key
- biometric unlock configuration metadata
- migration version

The user-facing filename must **never** be used as the OPFS filename.

Objects use random IDs such as UUIDv7/UUIDv4.

## 11.1 All OPFS I/O happens inside the vault worker

Reads and writes go through `createWritable()` and `getFile()` from inside the worker
that owns the master key. The main thread never touches OPFS.

Two Chromium behaviours to design around:

- `createWritable()` writes into a **swap file** and only commits on `close()`. A crash
  or an abandoned write leaves the original untouched, which hands object writes
  atomicity for free and covers most of what SS12 asks for.
- That swap file means an in-flight write **transiently doubles disk usage** for the
  object being written. Importing a 500 MB file needs roughly 1 GB of headroom. The
  quota check in SS25 must account for this or it will happily pass immediately before
  the write fails.

---

# 12. Manifest and Crash Safety

The encrypted manifest maps object IDs to decrypted metadata.

Example decrypted logical shape:

```ts
interface VaultItem {
  id: string;
  displayName: string;
  originalName?: string;

  mimeType: string;
  size: number;

  createdAt: string;
  importedAt: string;
  modifiedAt: string;

  tags: string[];
  collectionId?: string;
  notes?: string;

  documentDate?: string;
  expiresAt?: string;

  objectId: string;
  wrappedFileKey: string;

  sha256?: string;

  favorite: boolean;
  archived: boolean;
}
```

The persisted representation is encrypted.

Manifest updates should be crash-safe.

A simple V1 implementation may use alternating encrypted snapshots:

```text
manifest-a.enc
manifest-b.enc
active
```

Write the next snapshot fully, verify it, and only then change `active`.

**Mutations must be serialised.** The scheme reads `active`, writes the *other*
slot, then flips. Two concurrent mutations both read the same `active`, both
target the same inactive slot, and the second silently overwrites the first's
verified snapshot - so both operations report success while one change vanishes
at the next unlock, leaving an object with no manifest entry. The worker
therefore runs every state-changing verb through a queue. Reads stay concurrent;
they touch no shared state.

---

# 13. Search

Search is local-only.

When the vault is locked:

- no decrypted search index remains available;
- filenames/tags should not be queryable.

When unlocked:

1. decrypt manifest;
2. build an in-memory search index;
3. discard the index when the vault locks.

Search targets:

- display name
- original filename
- tags
- collections
- notes
- date
- issuer/employer
- custom fields

Example queries:

```text
passport
passport photo
salary july
salary slip 2026
visa
PAN
college certificate
```

---

# 14. Collections and Tags

Collections are optional logical groupings.

Examples:

- Identity
- Employment
- Finance
- Education
- Travel
- Insurance
- Receipts
- Photos
- Certificates
- Miscellaneous

Tags are free-form and many-to-many.

Examples:

```text
passport
photo
identity
salary-slip
tax
visa
resume
certificate
2026
```

A document may exist in one collection while having many tags.

Folders are not required.

---

# 15. Importing Files

Supported import mechanisms should include:

1. File picker
2. Multi-file picker
3. Drag and drop
4. Paste where browser APIs expose a file
5. Photo library picker on mobile
6. Android native Web Share Target

After receiving a file, **do not immediately commit it to the vault without user visibility**.

Show an import sheet.

Example:

```text
┌──────────────────────────────────┐
│ Add to Vault                     │
│                                  │
│ passport-photo.jpg               │
│ 624 KB · JPEG                     │
│                                  │
│ Name                             │
│ [ Passport Photo              ]  │
│                                  │
│ Collection                       │
│ [ Identity                    ▼] │
│                                  │
│ Tags                             │
│ [passport] [photo] [identity]    │
│                                  │
│ Notes                            │
│ [                           ]    │
│                                  │
│          Cancel   Encrypt & Save │
└──────────────────────────────────┘
```

Allow batch imports.

---

# 16. Android Web Share Target

The installed PWA should contain a `share_target` manifest entry using `POST` with `multipart/form-data` so binary files can be received.

Conceptual manifest:

```json
{
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url",
      "files": [
        {
          "name": "files",
          "accept": [
            "image/*",
            "application/pdf",
            "text/plain",
            ".pdf",
            ".jpg",
            ".jpeg",
            ".png",
            ".webp"
          ]
        }
      ]
    }
  }
}
```

The exact accepted list may be broadened later.

## Share receiver behavior

The share target navigation **is an app launch** - Android brings the PWA to the
foreground and the import sheet is on screen a second later. The handoff is therefore
short-lived, and it stays in memory.

1. Service Worker intercepts `POST /share-target`.
2. It parses the multipart body with `request.formData()` and validates the files.
3. It parks the resulting `File` objects in a module-scope `Map` under a random token.
4. It responds `Response.redirect("/?share=<token>", 303)`.
5. It wraps the handshake in `event.waitUntil()` so it is not reaped mid-handoff -
   resolving when the page claims the payload, or on a ~60s timeout.
6. The page reads the token and `postMessage`s the worker for the files. Blobs are
   structured-cloneable and refcounted, so handing over a 500 MB file does not copy
   500 MB into the page heap.
7. If the vault is locked, the unlock screen appears with the pending import held in
   memory behind it.
8. Bytes are encrypted and committed only after the user confirms.

## Shared files are never staged as plaintext

Step 3 deliberately does **not** write to OPFS. The Service Worker cannot hold the
master key, so anything it wrote to disk would be plaintext.

The case that settles this is *share into a locked vault*. The app opens, but to the
unlock screen. If the user walks away, Android discards the page and reaps the worker.
With an in-memory handoff the pending import simply evaporates and the user re-shares.
With OPFS staging, a plaintext passport scan sits in the vault directory across
sessions waiting for a sweeper to notice it.

**Losing a pending import is the correct failure. Leaking one is not.**

`/vault/temp/` is still swept unconditionally at boot and on lock, because backup and
restore stage there.

## To verify early

Whether `request.formData()` streams a large multipart body or buffers it into the heap
is not usefully specified anywhere. Test a ~300 MB share on a real device before
building on it. An OOM there is the only good reason to reconsider disk staging.

Never render shared HTML as trusted HTML.

Never infer safety from MIME type alone.

---

# 17. Locking Behavior

The vault has explicit states:

```text
UNINITIALIZED
LOCKED
UNLOCKING
UNLOCKED
LOCKING
ERROR
```

The Master Key must exist in memory only while the vault is unlocked.

Lock when:

- user presses Lock;
- configurable inactivity timeout expires;
- browser session is terminated;
- the app receives an explicit security-reset event.

Optional setting:

```text
Auto-lock
○ Immediately when app leaves foreground
● After 1 minute
○ After 5 minutes
○ After 15 minutes
○ Never while app remains open
```

Mobile foreground/background events are not perfectly reliable security boundaries, so cryptographic key lifetime should be minimized.

**Locking must cancel work already in flight, not merely drop the key.** A read
that has already unwrapped a file key holds everything it needs; clearing the
master key reference does not stop it, and it will finish decrypting and hand
plaintext to the UI after the vault is supposedly locked. The vault keeps an
epoch counter that every lock increments, and long-running operations check it
between chunks and abort when it moves.

---

# 18. Optional Face ID / Fingerprint / Device Unlock

The user may optionally configure device-backed unlock.

The UX may call this:

> Unlock with this device

The app should not promise a specific biometric because WebAuthn may invoke:

- fingerprint
- Face ID / face recognition
- Windows Hello
- device PIN
- screen lock
- another platform authenticator

The actual method is controlled by the user's device and browser.

---

# 19. Secure WebAuthn Unlock Design

Plain WebAuthn authentication alone must **not** be treated as sufficient to recover the encryption key.

For true cryptographic biometric/passkey unlock, require a WebAuthn authenticator/browser combination that supports the **PRF extension**.

Conceptually:

```text
WebAuthn credential
       │
   user verification
       │
       ▼
 WebAuthn PRF output
       │
       ▼
Device Unlock KEK
       │
       ▼
decrypt a wrapped copy of MasterKey
```

The app stores an additional Master Key wrapper:

```text
Passphrase wrapper
└── ALWAYS REQUIRED FOR RECOVERY

Device PRF wrapper
└── OPTIONAL CONVENIENCE UNLOCK
```

The Master Key itself remains the same.

---

# 20. WebAuthn Enrollment

When the user selects:

```text
Settings
→ Security
→ Unlock with this device
```

The app should:

1. require the vault to already be unlocked;
2. require the user's vault passphrase or another high-confidence confirmation;
3. create a WebAuthn credential with user verification required;
4. request the PRF extension;
5. verify that a PRF result is actually returned;
6. derive a device-specific KEK from the PRF result;
7. wrap the Master Key with that KEK;
8. store:
   - credential ID;
   - PRF salt/input;
   - wrapped Master Key;
   - algorithm/version data.

If PRF support is unavailable:

```text
Biometric/device unlock isn't securely supported by this browser/device.

You can continue using your vault passphrase.
```

Do **not** silently downgrade to storing an easily retrievable Master Key.

---

# 21. WebAuthn Unlock

On future launches:

```text
┌────────────────────────────────┐
│ 🔐 Local Vault                 │
│                                │
│ [ Unlock with this device ]    │
│                                │
│             or                 │
│                                │
│ [ Enter vault passphrase ]     │
└────────────────────────────────┘
```

If device unlock fails or becomes unavailable, passphrase unlock always remains available.

---

# 22. Recovery Rule

**A biometric/passkey must never be the only recovery mechanism for a vault backup.**

Every vault must retain a passphrase-wrapped Master Key.

This protects against:

- lost phone;
- deleted passkey;
- authenticator reset;
- browser changes;
- platform incompatibility;
- WebAuthn PRF support differences;
- restoring on a new device.

---

# 23. Persistent Storage

On vault creation and appropriate subsequent user interactions, request:

```ts
await navigator.storage.persist();
```

Check status using:

```ts
await navigator.storage.persisted();
```

Possible UI:

```text
Storage protection

● Persistent storage enabled
  Browser storage pressure should not automatically
  evict this vault.

Last checked: just now
```

or:

```text
Storage protection

⚠ Persistent storage NOT granted

Your browser may clear this site's local data under
storage pressure.

Create an encrypted backup before relying on this
device as the only copy.

[ Try Again ] [ Export Backup ]
```

---

# 24. Storage Safety Requirements

The app must:

- request persistent storage;
- display whether persistence was granted;
- check persistence status at every meaningful launch;
- check storage usage after large imports;
- never silently delete vault objects;
- provide visible backup status;
- detect inconsistencies between metadata and encrypted objects when possible.

Use:

```ts
navigator.storage.estimate()
```

to obtain browser-provided usage/quota estimates.

Example:

```text
Local Storage

Vault size       1.8 GB
Browser quota    ~42 GB
Usage            4%

Persistent       Yes
Last backup      12 days ago
```

The app must clearly distinguish browser quota estimates from exact physical free disk space.

---

# 25. Low-Space Warnings

The browser does not provide a reliable cross-platform event saying:

> "Your vault will be deleted in 30 seconds."

Therefore the app must use **proactive risk warnings**, not promise an impossible deletion notification.

Suggested warning conditions:

### Warning

Show when:

```text
remaining estimated quota < max(1 GB, 10% of quota)
```

### Critical

Show when:

```text
remaining estimated quota < max(250 MB, 3% of quota)
```

Exact thresholds should remain configurable in code.

Thresholds must also account for the write amplification in SS11.1: an import needs
roughly **twice** the incoming file's size in free quota while `createWritable()` holds
its swap file, not once.

Example:

```text
⚠ Storage is getting low

Your vault currently uses 3.8 GB and this browser is
approaching its available storage quota.

No vault files will be automatically deleted by Local Vault.

We recommend creating a backup before adding more files.

[ Export Backup ]
```

If persistent storage is not granted, the warning should be stronger.

---

# 26. Limits of the Web Platform

The product must be honest about the following:

A PWA cannot absolutely guarantee that local data survives:

- the user clearing browser/site data;
- browser profile deletion;
- OS/app uninstall behavior;
- device failure;
- browser bugs;
- storage corruption;
- unsupported/private browsing environments.

The application can request persistent storage and reduce eviction risk, but backups remain essential.

---

# 27. Backup System

Encrypted backup is a **core V1 feature**.

The user selects:

```text
Settings
→ Backup & Restore
→ Export Encrypted Backup
```

The app creates a portable ZIP archive.

Suggested extension:

```text
local-vault-2026-09-05.vault.zip
```

or:

```text
my-vault.vault.zip
```

The archive contains only encrypted vault data plus the minimal non-sensitive header needed to unlock it.

---

# 28. Backup ZIP Format

Recommended format:

```text
local-vault.vault.zip
│
├── vault.json
├── manifest.enc
└── objects/
    ├── 019ab45d....bin
    ├── 019ab46e....bin
    └── 019ab4ff....bin
```

`vault.json`:

```ts
interface VaultBackupHeader {
  magic: "LOCAL_VAULT_BACKUP";
  formatVersion: number;

  vaultId: string;
  createdAt: string;

  crypto: {
    masterKeyWrapperVersion: number;

    passphrase: {
      kdf: "argon2id";
      salt: string;
      params: {
        memory: number;
        iterations: number;
        parallelism: number;
      };
      wrappedMasterKey: string;
    };
  };

  manifest: {
    path: "manifest.enc";
  };
}
```

Do not include decrypted filenames/tags/notes in `vault.json`.

---

# 29. Backup Performance

Backups may become large.

Implementation requirements:

- stream OPFS objects into ZIP where possible;
- avoid concatenating the entire vault into one JavaScript `ArrayBuffer`;
- perform ZIP creation in a worker;
- show progress;
- support cancellation before final export where feasible.

Example:

```text
Creating encrypted backup

██████████████░░░░░░  68%

1.23 GB / 1.81 GB
482 / 712 files

[ Cancel ]
```

---

# 30. Export Destinations

After generating the encrypted backup:

## Desktop

Offer:

- Download
- Save using available browser file APIs

## Mobile

Prefer the Web Share API with the generated backup as a shared file where supported.

This allows the system share sheet to offer destinations such as:

- Google Drive
- iCloud Drive / Files
- Dropbox
- Nearby Share / Quick Share
- Messaging apps
- local file managers

Conceptual flow:

```text
Export Backup                          <- tap 1
      |
Generate encrypted ZIP -> /vault/temp/     (progress, cancellable)
      |
"Backup ready - 1.81 GB"
      |
Share   /   Save                       <- tap 2
      |
System Share Sheet
      |
Google Drive / Files / etc.
```

## Two taps, not one (normative)

`navigator.share()` requires transient user activation, and that activation does not
survive a 90-second encrypt-and-zip. Calling `share()` at the end of a long export
throws `NotAllowedError`.

Export is therefore two deliberate gestures: one to start generating, and a second,
separate tap on **Share** or **Save** once the archive is ready. The UI must not
present this as a single continuous action.

Assume large file shares fail on Android - the size ceiling is undocumented and real.
Save-to-disk is the primary path; the share sheet is the convenience.

## Getting a multi-GB file out without buffering it

`new Blob(chunks)` dies somewhere around 1-2 GB, and `showSaveFilePicker()` is a File
System Access picker - **desktop Chromium only**, absent on Android Chrome.

- **Desktop:** `showSaveFilePicker()`, stream the ZIP straight into the returned
  handle.
- **Android:** write the ZIP into `/vault/temp/`, `getFile()` the handle, then
  `URL.createObjectURL(file)`. The browser streams off disk and the JS heap stays flat.

Revoke the object URL as soon as the download or share settles, and delete the temp
file.

The PWA itself does **not** need Google OAuth or a Google Drive API integration for
this flow. The user chooses the destination using the OS share sheet.

---

# 31. Plaintext Export

Encrypted backup and plaintext export are separate concepts.

Default backup:

```text
Encrypted backup ZIP
```

Optional advanced action:

```text
Export decrypted files
```

If plaintext export is implemented, require explicit confirmation:

```text
⚠ This export will contain readable copies of your files.

Anyone with access to the ZIP will be able to open them.

[ Cancel ] [ Export Decrypted Files ]
```

Plaintext export must never be the default backup format.

---

# 32. Backup Reminder

Store only local reminder metadata.

Suggested settings:

```text
Backup reminders
● Every 14 days
○ Every 30 days
○ Never
```

Since a PWA cannot reliably run arbitrary background tasks on every platform, reminder checks should occur at app launch/unlock.

Example dashboard warning:

```text
Backup recommended

Last backup: 23 days ago

[ Export Backup ]
```

The app may also display the number of documents changed since the last successful backup.

---

# 33. Restore

On a fresh installation:

```text
Create New Vault
Restore Existing Vault
```

Restore flow:

1. user chooses `.vault.zip`;
2. inspect `vault.json`;
3. validate magic + supported format version;
4. validate archive paths to prevent ZIP traversal;
5. request the vault passphrase;
6. derive KEK;
7. unwrap Master Key;
8. verify/decrypt manifest;
9. validate objects and integrity data;
10. ensure sufficient quota is likely available;
11. request persistent storage;
12. import encrypted objects into OPFS;
13. verify copied data;
14. atomically activate restored manifest;
15. open vault.

### How that is actually guaranteed

Steps 12-14 happen in a **new generation** (SS11), never over the live vault:

1. everything is validated - magic, version, passphrase, manifest, and that every
   item the manifest references has an entry in the archive;
2. objects are written into a fresh generation, which nothing points at;
3. **every chunk of every object is authenticated, read back off disk**;
4. the manifest and header are written into that generation;
5. `/current` is rewritten - a single small write, and the new vault is live;
6. the superseded generation is collected.

Checking that an archive merely *contains* a file of the right name is not
checking it at all. Without step 3 a truncated, corrupted or substituted object
restores cleanly, reports success, and is discovered months later when the
document is opened - by which time the healthy vault it replaced is long gone.
Step 3 doubles restore I/O and is worth every byte.

A failed restore must not destroy an existing vault, and with this ordering it
cannot: before step 5 the old vault is still the live one, and after step 5 the
new one is. There is no moment where neither is.

---

# 34. Restore Conflict Handling

If a vault already exists, do not merge automatically.

Show:

```text
A vault already exists on this device.

○ Cancel
○ Replace current vault
○ Restore as separate vault (future)
```

V1 may support only **Replace**.

Before replacement, recommend exporting the current vault.

Replacement should be staged first and activated only after verification.

---

# 35. Backup Integrity

Each encrypted object should have integrity information sufficient to detect:

- truncated files;
- damaged chunks;
- missing objects;
- mismatched object IDs;
- invalid authentication tags.

AES-GCM authentication already detects ciphertext modification at the chunk level.
It does not, on its own, detect any of the following, so these are checked
explicitly:

- **An internally inconsistent header.** The object header is plaintext and
  therefore attacker-controlled. `totalChunks: 0` with `plaintextSize: 0` is a
  truncation that "authenticates" perfectly - the decrypt loop runs zero times,
  no tag is ever checked, and a non-empty document reads back as an empty blob
  with no error. Decoding rejects any header whose chunk count disagrees with its
  declared size, or whose chunk size is implausible.
- **A size that disagrees with the manifest.** The manifest is authenticated, so
  it is the authority on how large a document is; the plaintext header is not.
- **Bytes after the final chunk.** The tags prove each chunk and the AAD proves
  how many there should be, but neither says anything about what follows the last
  one. Only comparing against the real file length catches an appended object.

The manifest may additionally store a hash of the original plaintext for duplicate detection and end-to-end verification.

If plaintext hashes are considered sensitive correlation metadata, keep them inside the encrypted manifest.

---

# 36. Duplicate Detection

Optional V1/V1.1 feature:

Compute SHA-256 locally before encryption.

If a matching decrypted manifest hash already exists:

```text
This file may already be in your vault.

Existing:
Passport Photo
Added Apr 18, 2026

[ View Existing ] [ Save Another Copy ]
```

The hash must not be sent anywhere.

---

# 37. File Preview

Supported previews may include:

- JPEG
- PNG
- WebP
- PDF
- plain text where safe

Preview flow:

```text
encrypted OPFS object
       ↓
decrypt requested chunks
       ↓
Blob / object URL
       ↓
preview
```

Revoke temporary object URLs when no longer needed.

Do not persist decrypted preview files.

## PDF preview conflicts with the CSP

The browser's built-in PDF viewer is reachable only through `<embed>`/`<object>` or an
`<iframe>`. SS43 sets `object-src 'none'` and `frame-src 'none'`, which blocks exactly
those. This is a real conflict and it gets a deliberate answer rather than a silent CSP
relaxation:

**Decided: self-host `pdf.js` and render to a canvas.** `frame-src` and `object-src`
stay at `'none'` on the one application that holds decrypted identity documents, and
SS42's "self-host every dependency" holds.

Implementation notes that matter:

- pdf.js is **lazily imported**. It is ~1.7 MB across library and worker, and most
  vault items are not PDFs, so it stays out of the initial bundle entirely.
- Bytes are handed to `getDocument({ data })`, never a URL, and `useWorkerFetch`,
  `disableAutoFetch` and `disableStream` are all off. Nothing is fetched, which is
  what lets `connect-src` stay at `'none'`.
- pdf.js v6 no longer uses `eval`, so no `unsafe-eval` is required. The
  `'wasm-unsafe-eval'` already present for Argon2 is unrelated and unaffected.
- Its worker is emitted same-origin and hashed by the bundler, satisfying
  `worker-src 'self'`.
- Verified: a PDF using **non-embedded base-14 Helvetica** renders correctly under
  `connect-src 'none'`. Standard-font substitution happens locally, so no font data
  needs fetching.

---

# 38. File Actions

Every vault item should support:

- Preview
- Rename
- Edit tags
- Move collection
- Edit notes
- Favorite
- Archive
- Share
- Save As / Download
- Replace with newer version
- Delete

---

# 39. Deletion

Deletion should require explicit user intent.

Recommended:

```text
Delete "Passport Scan"?

This removes the encrypted local copy from your vault.

Your previous exported backups may still contain it.

[ Cancel ] [ Delete ]
```

Optional V1 behavior:

- soft-delete into encrypted Trash;
- retain for 30 days only if the user explicitly enables automatic Trash cleanup.

Default security principle:

**Do not automatically delete user documents.**

---

# 40. Sharing a Decrypted File

The user may explicitly share an individual vault item.

Flow:

1. require unlocked vault;
2. decrypt file to an in-memory/temporary Blob;
3. invoke `navigator.share({ files: [...] })` where supported;
4. otherwise offer Save As / Download;
5. release temporary data immediately afterward.

The UI must make clear that sharing creates a readable copy outside the vault.

---

# 41. Offline PWA

After successful installation/cache initialization, the following must function offline:

- unlock;
- browse;
- search;
- import from local picker;
- preview;
- edit metadata;
- delete;
- encrypted backup creation;
- local restore;
- device unlock where the browser/authenticator supports offline WebAuthn operation.

The application shell should be cached by the Service Worker.

---

# 42. Service Worker Update Safety

Because the app can access decrypted files after unlock, a malicious application update is a major threat.

Mitigations:

- no runtime third-party scripts;
- strict CSP;
- self-host every dependency;
- immutable hashed application assets;
- reproducible production builds where practical;
- show application version/build hash in Settings.

Optional paranoid mode:

```text
Application update available

Installed build:
8f21a4c

New build:
53ac21e

[ Later ] [ Install Update ]
```

Do not apply an update while sensitive operations such as backup/import are mid-flight.

---

# 43. Content Security Policy

Target a restrictive CSP.

Conceptual baseline:

```text
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self';
img-src 'self' blob: data:;
font-src 'self';
media-src 'self' blob:;
object-src 'none';
frame-src 'none';
base-uri 'none';
form-action 'none';
connect-src 'none';
worker-src 'self';
manifest-src 'self';
```

Adjust only when required by an implemented feature.

## Why `'wasm-unsafe-eval'`

`script-src 'self'` alone blocks WebAssembly compilation in Chromium. Argon2id is WASM,
so the directive is required. It permits `WebAssembly.compile`/`instantiate`; it does
not re-enable `eval()` or inline script.

## Why `connect-src 'none'` survives

Fetching a `.wasm` by URL is a `connect-src` request, so a naive Argon2 build would
force this open to `'self'`. `hash-wasm` embeds its WASM in the JS bundle as base64, so
there is no fetch and the directive stays at `'none'`. That is the reason for the
dependency choice - preserve it if the library is ever swapped.

## `form-action 'none'` and the share target

`form-action 'none'` should not block the Android share target: that POST is an
OS-initiated navigation handled by the Service Worker, not a form submission from the
document. Verify it on a real device early anyway - the failure mode would be silent
and Android-only.

No inline/eval-based JavaScript is required.

---

# 44. Network Privacy

Normal vault operation should make **zero application-initiated network requests**.

The app may still be served/updated from its hosting origin when online.

No vault operation should call:

- analytics endpoints;
- error-reporting SaaS with document metadata;
- Google APIs;
- OCR APIs;
- LLM APIs;
- CDN dependencies.

A future optional sync feature would require a separate threat model and is not included here.

---

# 45. OCR

Optional future feature.

If added, OCR must run entirely on-device/in-browser using WASM or supported local browser ML.

Do not upload documents to an OCR service.

Potential extracted fields:

- document title
- dates
- ID labels
- issuer
- suggested tags

The user must confirm suggestions before saving them to metadata.

---

# 46. Expiry Dates

Allow an optional `expiresAt`.

Useful for:

- passports
- visas
- licenses
- insurance
- certificates

Dashboard:

```text
Expiring Soon

Passport
Expires in 5 months

Travel Insurance
Expires in 16 days
```

Local notifications may be added where browser/platform support permits, but core correctness must not depend on notification delivery.

---

# 47. Suggested Main UI

```text
┌───────────────────────────────────────────────┐
│ Local Vault                         🔒  ⚙     │
│                                               │
│ 🔎 Search your vault...                       │
│                                               │
│ Pinned                                        │
│ ┌─────────────┐ ┌─────────────┐               │
│ │ Passport    │ │ Resume      │               │
│ │ Photo       │ │ Latest      │               │
│ └─────────────┘ └─────────────┘               │
│                                               │
│ Collections                                   │
│ Identity       12                             │
│ Employment     34                             │
│ Finance        18                             │
│ Education       9                             │
│                                               │
│ Recent                                        │
│ August Salary Slip.pdf                        │
│ Passport Photo                                │
│ Form 16 2025-26.pdf                           │
│                                               │
│                              ＋ Add            │
└───────────────────────────────────────────────┘
```

---

# 48. Storage / Backup Dashboard

Settings should expose storage health clearly.

```text
Storage & Backup

Local vault
1.84 GB · 712 files

Storage protection
● Persistent

Browser quota
1.84 GB / ~42 GB

Last integrity check
Today

Last encrypted backup
August 17, 2026

Changes since backup
23 files

[ Export Encrypted Backup ]
[ Restore Backup ]
```

---

# 49. Capability Detection

Create a centralized capability object.

Example:

```ts
interface PlatformCapabilities {
  // required - missing any of these means the app cannot run
  opfs: boolean;
  opfsWritable: boolean; // createWritable(); Safari fails here
  serviceWorker: boolean;
  webCrypto: boolean;

  // graceful degradation
  persistentStorageRequest: boolean;
  persistentStorageGranted: boolean;

  webShare: boolean;
  webShareFiles: boolean;
  webShareTargetExpected: boolean;

  webAuthn: boolean;
  webAuthnPrf: boolean;

  fileSystemAccess: boolean; // showSaveFilePicker(); desktop only
}
```

## 49.1 Boot gate

`opfs`, `opfsWritable`, `serviceWorker` and `webCrypto` are **required**. If any is
missing, the app renders a full-screen unsupported notice instead of the vault, naming
what is missing and which browsers do work.

`opfsWritable` is checked as `typeof handle.createWritable === "function"` on a handle -
a `typeof` probe, no test write required. Safari fails this check and lands on the
unsupported screen without ever being named in the code. That is the point: SS4's scope
decision is enforced by capability, not by user-agent string.

Everything else degrades rather than blocks. No PRF hides device unlock (SS20). No
`showSaveFilePicker` switches export to the object-URL path (SS30). No Web Share Target
just means the share entry point does not exist.

Do not scatter browser sniffing through UI components. Prefer actual API detection.

Some capabilities, such as installed Web Share Target integration, may require
platform-level expectations in addition to JavaScript detection.

---

# 50. Error Handling

Security-sensitive failures must fail closed.

Examples:

### Cannot decrypt manifest

```text
Vault could not be unlocked.

The passphrase may be incorrect or the vault data may be damaged.
```

Do not partially display unverified metadata.

### Missing object

```text
One vault file appears to be missing or damaged.

Passport Scan
Added: Apr 18, 2026

Restore it from a backup if available.
```

### Persistence unavailable

```text
Persistent browser storage is unavailable.

Your vault can still work, but local data may be at greater risk of
being cleared under storage pressure.

Create regular encrypted backups.
```

---

# 51. Integrity Check

Provide:

```text
Settings
→ Storage & Backup
→ Verify Vault
```

Verification checks:

- manifest decrypts;
- every referenced object exists;
- object header matches expected ID;
- every encrypted chunk authenticates;
- object sizes are valid;
- no unexpected temp objects are active;
- no manifest references are orphaned.

Do not require decrypting every full file into memory at once.

---

# 52. Security Threat Model

## Protect against

- someone casually inspecting browser storage;
- copied OPFS/browser profile data;
- a stolen encrypted backup ZIP;
- filename/metadata leakage from OPFS;
- corrupted backup data;
- offline passphrase guessing as much as practical;
- cross-site access under the normal browser origin model;
- accidental local file loss through lack of backup awareness.

## Partially protect against

- stolen unlocked device;
- malicious browser extensions;
- compromised operating system;
- malware with user-session access.

## Cannot protect against

- malicious code served from the application's own compromised origin after the user unlocks;
- fully compromised browser/OS;
- screen capture by the OS;
- a user exporting a plaintext document and leaving it elsewhere;
- weak passphrases;
- user intentionally clearing local site data.

---

# 53. Application Hosting

Use a dedicated stable HTTPS origin.

```text
vault.chakri.me
```

This is a **one-way door**. OPFS is origin-scoped and WebAuthn credentials are
RP-scoped, so moving the hostname after anyone has created a vault orphans their
local data and invalidates their device unlock. There is no migration path,
because the app cannot read the old origin's storage from the new one.

The origin must remain stable because:

- OPFS is origin-scoped;
- WebAuthn credentials are RP/origin scoped;
- changing domains may make existing device unlock credentials unusable;
- browser storage lives under the origin.

Do not casually move between:

```text
vault.example.com
www.vault.example.com
example.com/vault
```

after users create vaults.

---

# 54. Deployment Security

Recommended:

- HTTPS only
- HSTS
- restrictive CSP
- `X-Content-Type-Options: nosniff`
- appropriate `Referrer-Policy`
- restrictive `Permissions-Policy`
- no third-party scripts
- lock dependencies
- dependency audit
- deterministic/verified builds where practical
- immutable hashed assets

The vault application's hosting account should itself use strong MFA/passkeys.

## 54.1 What the chosen host actually delivers

Deployment is GitHub Pages via GitHub Actions (`.github/workflows/deploy.yml`).
Pages serves static files with fixed headers and **no way to add custom ones**,
so the list above is only partly achievable. Being precise about the gap matters
more than pretending it is closed:

| Control | On GitHub Pages | How |
| --- | --- | --- |
| HTTPS only | yes | enforced by Pages |
| HSTS | yes | sent by Pages |
| Restrictive CSP | yes, mostly | `<meta http-equiv>` injected at build |
| `frame-ancestors` | **no** | ignored in `meta`; see below |
| `X-Content-Type-Options` | **no** | header-only, unavailable |
| `Referrer-Policy` | partly | `<meta name="referrer" content="no-referrer">` |
| `Permissions-Policy` | **no** | header-only, unavailable |
| No third-party scripts | yes | everything is self-hosted |
| Locked dependencies | yes | `npm ci` + committed lockfile |
| Dependency audit | yes | `npm audit --omit=dev` in CI |
| Immutable hashed assets | yes | emitted by the bundler |

**The `frame-ancestors` gap is mitigated in code, not ignored.** A `meta` CSP
silently drops that directive, which would leave the app framable by any origin -
and a vault whose "Save decrypted file" button can be steered by an invisible
overlay is a real problem. `main.ts` therefore compares `window.self` to
`window.top` before booting and refuses to render at all inside a frame. That
comparison needs no cross-origin access, so it holds regardless of who is
framing.

`X-Content-Type-Options` and `Permissions-Policy` have no in-document
equivalent. The residual risk is small here - Pages sets correct MIME types, and
the app requests no permissions - but it is residual risk, not zero.

Moving to a host that can send headers (Cloudflare Pages and Netlify both
support a `_headers` file) would close all three gaps and delete the frame check.
The CSP is already defined once in `vite.config.ts` and served as a real header
in dev, so that migration is a config change, not a rewrite.

---

# 55. Data Migration

Every persisted structure must contain a format version.

Examples:

```text
vaultFormatVersion
manifestVersion
objectFormatVersion
backupFormatVersion
```

Migrations must:

1. never overwrite the only valid copy before successful conversion;
2. create a temporary migrated representation;
3. validate it;
4. atomically activate it;
5. retain rollback data until success is confirmed.

Backup restore should support at least several older archive versions when feasible.

---

# 56. File Size Limits

Do not hardcode a tiny file size limit.

The practical limit depends on:

- browser quota;
- available device storage;
- OPFS implementation;
- temporary memory requirements;
- ZIP export strategy.

Use streaming/chunked pipelines so importing a 500 MB file does not require 500 MB+ of JavaScript heap.

V1 UI may warn for unusually large files.

---

# 57. Performance Requirements

Target:

- application shell opens instantly from cache;
- metadata search feels immediate for thousands of documents;
- crypto work does not block the main UI thread;
- import progress is visible for files taking noticeable time;
- backup and restore are streaming operations;
- previews decrypt only what is necessary where feasible.

Use Web Workers for:

- Argon2id
- large-file encryption/decryption
- hashing
- ZIP generation
- backup validation

---

# 58. Accessibility

Minimum requirements:

- keyboard navigation;
- visible focus state;
- screen-reader labels;
- no color-only security indicators;
- accessible lock/unlock states;
- touch targets suitable for mobile;
- support system light/dark preference;
- biometric unlock still has a passphrase fallback.

---

# 59. V1 Required Features

## Vault

- [x] Create encrypted vault
- [x] Passphrase unlock
- [x] Lock
- [x] Auto-lock
- [x] OPFS encrypted object storage
- [x] Encrypted metadata manifest
- [x] Add file
- [x] Multi-file import
- [x] Rename
- [x] Tags
- [x] Collections
- [x] Notes
- [x] Favorite
- [x] Search
- [x] Preview images
- [x] Preview PDFs
- [x] Download/Save As
- [x] Share individual decrypted file
- [x] Delete

## PWA

- [x] Installable manifest
- [x] Offline application shell
- [x] Service Worker
- [ ] Android Web Share Target
- [x] In-memory share handoff (never plaintext to OPFS)
- [x] Capability boot gate (§49.1)

## Security

- [x] AES-GCM encrypted files
- [x] Random per-file keys
- [x] Argon2id passphrase KDF
- [x] Master Key wrapping
- [x] Strict CSP
- [x] No third-party network calls
- [x] Optional WebAuthn PRF device unlock
- [x] Passphrase recovery always available

## Storage

- [x] `navigator.storage.persist()`
- [x] `navigator.storage.persisted()`
- [x] storage status UI
- [x] quota estimate
- [x] low-space warnings
- [x] no automatic vault deletion
- [x] integrity check

## Backup

- [x] encrypted ZIP export
- [x] streaming export
- [x] Download/Save fallback
- [ ] native share sheet export where available
- [ ] Google Drive usable as an OS share destination
- [x] encrypted ZIP restore
- [x] restore validation
- [x] backup reminders
- [x] show last backup date
- [x] show changes since last backup

---

# 60. V1.1 / V2 Ideas

- [x] Duplicate detection
- [ ] Expiry-date dashboard
- [ ] Local OCR
- [ ] Version history
- [ ] Smart tag suggestions
- [ ] Encrypted Trash
- [ ] Multiple vaults
- [ ] Optional iOS native wrapper/share extension
- [ ] Reproducible build verification
- [ ] Paranoid manual-update mode
- [ ] Local notifications for expiring documents
- [ ] Import history
- [ ] Encrypted incremental backups
- [ ] Backup diffing
- [ ] Optional user-selected external folder backup
- [ ] NAS/WebDAV target, only after a separate security design
- [ ] Cross-device encrypted sync, only after a separate security design

---

# 61. Suggested User Stories

### Store a passport photo

```text
As a user,
I want to share or import a passport photo into my vault,
rename it "Passport Photo",
and tag it with "identity" and "passport",
so I can retrieve it immediately months later.
```

### Receive an Android share

```text
As an Android user,
I want Local Vault to appear in the native Share menu,
so I can save an attachment directly from Gmail or another app.
```

### Secure storage

```text
As a user,
I want the actual OPFS files and metadata to be encrypted,
so copying my browser profile does not reveal my documents.
```

### Biometric convenience

```text
As a user,
I want to unlock the vault with the authentication mechanism
supported by my device,
so I do not need to type my long passphrase every time.
```

### Passphrase recovery

```text
As a user,
I want my passphrase to remain a universal recovery mechanism,
so losing my phone or biometric/passkey credential does not
permanently destroy access to my backup.
```

### Export backup

```text
As a user,
I want to export my entire encrypted vault as one ZIP,
share/save it to Google Drive or another location,
reinstall Local Vault later,
and restore everything using my vault passphrase.
```

### Storage pressure

```text
As a user,
I want to know whether the browser granted persistent storage
and whether my browser storage quota is getting low,
so I can create a backup before local storage becomes risky.
```

---

# 62. Acceptance Criteria

The V1 release is complete when all of the following are true:

1. A user can create a vault without creating an online account.
2. A file imported into the vault is encrypted before being committed to OPFS.
3. OPFS contains no user-facing filename or tag in plaintext.
4. Reloading the app leaves the vault locked.
5. Entering the correct passphrase restores access.
6. Entering an incorrect passphrase reveals no vault metadata.
7. Search works entirely locally after unlock.
8. Android can import files through the OS share target on supported browsers.
9. Shared files never touch disk unencrypted, and an unsupported browser gets an honest
   boot-time notice rather than a half-working vault.
10. The app requests persistent storage and clearly shows whether it was granted.
11. The app never automatically deletes a vault file because storage is low.
12. The app shows proactive quota/persistence warnings.
13. A user can create an encrypted ZIP backup.
14. The encrypted ZIP reveals no document filenames or document contents without the passphrase.
15. The ZIP can be saved/downloaded or handed to the native share sheet where supported.
16. A fresh installation can fully restore the ZIP using the passphrase.
17. Restoration does not depend on the old WebAuthn credential.
18. WebAuthn device unlock is offered only when the app can securely derive an unlock secret, such as through the PRF extension.
19. Disabling/removing biometric unlock does not require re-encrypting every vault file.
20. The app performs no runtime analytics/telemetry/document-upload requests.
21. Core vault functionality works offline after installation.

---

# 63. Security Invariants

These rules should be treated as architectural invariants, not optional implementation details:

1. **Master Key is never stored plaintext.**
2. **Document keys are never stored plaintext at rest.**
3. **Document metadata is encrypted at rest.**
4. **Passphrase recovery always exists.**
5. **WebAuthn/device unlock never replaces recovery.**
6. **Unsupported PRF must not silently degrade into insecure biometric unlock.**
7. **No vault content is uploaded automatically.**
8. **No vault object is automatically deleted to save space.**
9. **A backup must be verifiable before it is considered successful.**
10. **A restore must be verifiable before replacing an existing vault.**
11. **Sensitive cryptographic work must use established browser primitives/audited implementations rather than custom cryptography.**
12. **The UI must accurately communicate the limits of browser storage persistence.**

---

# 64. Final Product Model

The mental model should be:

```text
                        LOCAL VAULT
                            │
              ┌─────────────┴─────────────┐
              │                           │
           IMPORT                       SEARCH
              │                           │
    picker / Android share        name / tags / notes
              │                           │
              └─────────────┬─────────────┘
                            │
                         UNLOCKED
                            │
                    ┌───────┴────────┐
                    │                │
                encrypt          decrypt
                    │                │
                    ▼                ▼
                  OPFS            previews
                    │
                    ▼
              encrypted vault
                    │
                    ├───────────────┐
                    │               │
                    ▼               ▼
              persistent       encrypted ZIP
                storage            backup
                                    │
                                    ▼
                              native share
                              / save / Drive
                                    │
                                    ▼
                               RESTORABLE
```

The application is therefore not merely a local file browser.

It is a:

> **searchable, encrypted, offline personal document vault with portable user-owned backups.**
