/** Small byte helpers. No cryptography lives here. */

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Best-effort scrub. JS gives no guarantee, but it shortens the window.
 *
 * A buffer that has been transferred to a worker is *detached*, and filling it
 * throws. There is nothing to scrub in that case -- we no longer own the bytes,
 * the receiving context does -- so a detached buffer is a no-op, not an error.
 */
export function zero(b: Uint8Array): void {
  if (b.byteLength === 0) return;
  try {
    b.fill(0);
  } catch {
    /* detached: the bytes belong to whoever we handed them to */
  }
}

export function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) throw new Error("bad uuid");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesUuid(b: Uint8Array): string {
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

export function u64be(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}

export function readU32be(b: Uint8Array, off: number): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off, false);
}

export function readU64be(b: Uint8Array, off: number): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, false);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("value too large");
  return Number(v);
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export const utf8 = new TextEncoder();
export const fromUtf8 = new TextDecoder();
