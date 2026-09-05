import type { Progress } from "../vault/vault.ts";
import type { Envelope, Req, ResMap } from "./rpc.ts";

/**
 * Main-thread handle on the vault worker.
 *
 * Nothing here can reach a key; it can only ask. Requests are correlated by a
 * monotonic id, and progress arrives as intermediate envelopes on the same id.
 */
export class VaultClient {
  private worker = new Worker(new URL("./vault.worker.ts", import.meta.url), {
    type: "module",
  });
  private seq = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      onProgress?: (p: Progress) => void;
    }
  >();

  constructor() {
    this.worker.addEventListener("message", (e: MessageEvent) => {
      const env = e.data as Envelope;
      const entry = this.pending.get(env.id);
      if (!entry) return;

      if ("progress" in env) {
        entry.onProgress?.(env.progress);
        return;
      }
      this.pending.delete(env.id);
      if (env.ok) entry.resolve(env.value);
      else {
        const err = new Error(env.error.message);
        err.name = env.error.name;
        entry.reject(err);
      }
    });
  }

  call<K extends Req["t"]>(
    req: Extract<Req, { t: K }>,
    onProgress?: (p: Progress) => void,
  ): Promise<ResMap[K]> {
    const id = ++this.seq;
    return new Promise<ResMap[K]>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress,
      });
      this.worker.postMessage({ id, req });
    });
  }
}
