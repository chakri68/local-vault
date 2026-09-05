/**
 * The vault worker.
 *
 * This is the only context that ever holds the master key or sees plaintext at
 * rest. The main thread reaches it exclusively through the verbs in rpc.ts (§7).
 */
import { restoreBackup } from "../vault/backup.ts";
import * as opfs from "../vault/opfs.ts";
import { Vault } from "../vault/vault.ts";
import type { Progress } from "../vault/vault.ts";
import { storageStatus } from "../platform/storage.ts";
import type { Envelope, Req } from "./rpc.ts";

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: "message", handler: (e: MessageEvent) => void): void;
};

const vault = new Vault();

ctx.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as { id: number; req: Req };
  void handle(msg.id, msg.req);
});

async function handle(id: number, req: Req): Promise<void> {
  const onProgress = (p: Progress) => {
    const env: Envelope = { id, progress: p };
    ctx.postMessage(env);
  };

  try {
    const value = await dispatch(req, onProgress);
    ctx.postMessage({ id, ok: true, value } satisfies Envelope);
  } catch (e) {
    const err = e as Error;
    ctx.postMessage({
      id,
      ok: false,
      error: { name: err.name ?? "Error", message: err.message ?? String(e) },
    } satisfies Envelope);
  }
}

async function dispatch(req: Req, onProgress: (p: Progress) => void): Promise<unknown> {
  switch (req.t) {
    case "probe":
      return vault.probe();

    case "create":
      return vault.create(req.passphrase);

    case "unlock":
      return vault.unlock(req.passphrase);

    case "lock":
      return vault.lock();

    case "snapshot":
      return vault.snapshot();

    case "hashCandidate":
      return vault.hashCandidate(req.file, onProgress);

    case "import":
      return vault.importFile(req.file, req.meta, { sha256: req.sha256, onProgress });

    case "read":
      return vault.readItem(req.id, onProgress);

    case "update":
      return vault.updateItem(req.id, req.patch);

    case "delete":
      return vault.deleteItem(req.id);

    case "addCollection":
      return vault.addCollection(req.name);

    case "settings":
      return vault.updateSettings(req.patch);

    case "changePassphrase":
      return vault.changePassphrase(req.current, req.next);

    case "verify":
      return vault.verify(onProgress);

    case "storage":
      return storageStatus();

    case "exportBackup":
      return vault.exportBackup(onProgress);

    case "readBackup":
      return opfs.readTemp(req.tempName);

    case "discardBackup":
      return opfs.deleteTemp(req.tempName);

    case "restoreBackup": {
      const result = await restoreBackup(req.file, req.passphrase, { onProgress });
      vault.lock();
      await vault.probe();
      return result;
    }

    case "markBackedUp":
      return vault.markBackedUp(req.at);

    case "destroy":
      vault.lock();
      await opfs.destroyVault();
      await vault.probe();
      return undefined;
  }
}
