/**
 * Web Crypto throws `OperationError` with an *empty* message when an AES-GCM tag
 * fails to verify — which is the single most likely error in this app. Surfacing
 * `e.message` directly gives the user a blank red box, so everything
 * user-visible goes through here.
 */
export function describe(e: unknown, fallback: string): string {
  const err = e as Error | undefined;
  if (!err) return fallback;
  if (err.name === "AbortError") return "Cancelled.";
  if (err.name === "QuotaExceededError") {
    return "The browser ran out of storage quota for this site.";
  }
  if (err.name === "NotFoundError") {
    return "A file this operation needed is no longer there.";
  }
  return err.message?.trim() || fallback;
}

export const BAD_PASSPHRASE_OR_DAMAGED =
  "The passphrase may be incorrect, or the data may be damaged.";
