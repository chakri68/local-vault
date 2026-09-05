import { createSHA256 } from "hash-wasm";
import { concat, readU32be, readU64be, u32be, u64be } from "../bytes.ts";
import { CHUNK_SIZE, NONCE_BYTES, OBJECT_FORMAT_VERSION, TAG_BYTES } from "../types.ts";
import type { WrappedFileKey } from "./keys.ts";

/**
 * Encrypted object format (§9.5).
 *
 *   0   5   "LVOBJ"
 *   5   1   objectFormatVersion
 *   6  16   vaultId
 *  22  16   fileId
 *  38   4   chunkSize            uint32 BE
 *  42   8   plaintextSize        uint64 BE
 *  50   8   totalChunks          uint64 BE
 *  58  12   wrapped file key nonce
 *  70   2   wrapped file key length  uint16 BE
 *  72   n   wrapped file key
 *          then totalChunks ciphertext chunks, back to back
 *
 * The header is plaintext but carries nothing sensitive: random IDs, sizes and
 * ciphertext. It is not separately authenticated because it does not need to be —
 * vaultId, fileId, the version and totalChunks are all in every chunk's AAD, and
 * chunkSize/plaintextSize determine the chunk boundaries, so altering any of them
 * makes the first chunk fail to authenticate.
 */

const MAGIC = new Uint8Array([0x4c, 0x56, 0x4f, 0x42, 0x4a]); // "LVOBJ"
const HEADER_FIXED = 72;

export interface ObjectHeader {
  version: number;
  vaultId: Uint8Array;
  fileId: Uint8Array;
  chunkSize: number;
  plaintextSize: number;
  totalChunks: number;
  key: WrappedFileKey;
}

export function chunkCount(plaintextSize: number, chunkSize = CHUNK_SIZE): number {
  return Math.max(1, Math.ceil(plaintextSize / chunkSize));
}

export function encodeHeader(h: ObjectHeader): Uint8Array {
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, h.key.ct.length, false);
  return concat(
    MAGIC,
    new Uint8Array([h.version]),
    h.vaultId,
    h.fileId,
    u32be(h.chunkSize),
    u64be(h.plaintextSize),
    u64be(h.totalChunks),
    h.key.iv,
    len,
    h.key.ct,
  );
}

export function decodeHeader(buf: Uint8Array): { header: ObjectHeader; byteLength: number } {
  if (buf.length < HEADER_FIXED) throw new Error("object truncated: header incomplete");
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) throw new Error("not a vault object");
  }
  const version = buf[5];
  if (version !== OBJECT_FORMAT_VERSION) {
    throw new Error(`unsupported object format version ${version}`);
  }
  const keyLen = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint16(70, false);
  const byteLength = HEADER_FIXED + keyLen;
  if (buf.length < byteLength) throw new Error("object truncated: wrapped key incomplete");

  return {
    byteLength,
    header: {
      version,
      vaultId: buf.slice(6, 22),
      fileId: buf.slice(22, 38),
      chunkSize: readU32be(buf, 38),
      plaintextSize: readU64be(buf, 42),
      totalChunks: readU64be(buf, 50),
      key: { iv: buf.slice(58, 70), ct: buf.slice(72, byteLength) },
    },
  };
}

/**
 * Nonce = 4 zero bytes + the chunk index as uint64 BE (§9.5, normative).
 *
 * Safe because the File Key is fresh per file and used for exactly one file, so
 * a counter cannot collide. Do not replace this with random nonces.
 */
function nonce(chunkIndex: number): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  new DataView(n.buffer).setBigUint64(4, BigInt(chunkIndex), false);
  return n;
}

/**
 * AAD binds each chunk to its container and its position (§9.5, normative).
 * `totalChunks` is what makes truncation detectable — see §35.
 */
function aad(h: ObjectHeader, chunkIndex: number): Uint8Array {
  return concat(
    new Uint8Array([h.version]),
    h.vaultId,
    h.fileId,
    u64be(chunkIndex),
    u64be(h.totalChunks),
  );
}

export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface EncryptResult {
  /** SHA-256 of the plaintext, hex. Computed in the same pass (§36). */
  sha256: string;
  bytesWritten: number;
}

/**
 * Encrypt a Blob into a sink, one chunk at a time.
 *
 * Memory stays flat regardless of file size: each slice is pulled off disk,
 * encrypted, written, and dropped. Never call .arrayBuffer() on the whole blob.
 */
export async function encryptObject(
  source: Blob,
  fileKey: CryptoKey,
  header: ObjectHeader,
  sink: ByteSink,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<EncryptResult> {
  const hasher = await createSHA256();
  hasher.init();

  const encoded = encodeHeader(header);
  await sink.write(encoded);
  let bytesWritten = encoded.length;

  for (let i = 0; i < header.totalChunks; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const start = i * header.chunkSize;
    const end = Math.min(start + header.chunkSize, header.plaintextSize);
    const plain = new Uint8Array(await source.slice(start, end).arrayBuffer());

    hasher.update(plain);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce(i) as BufferSource, additionalData: aad(header, i) as BufferSource },
      fileKey,
      plain as BufferSource,
    );
    plain.fill(0);

    const out = new Uint8Array(ct);
    await sink.write(out);
    bytesWritten += out.length;
    opts.onProgress?.(end, header.plaintextSize);
  }

  return { sha256: hasher.digest("hex"), bytesWritten };
}

/** Ciphertext byte length of chunk `i`, derivable from the header alone. */
export function chunkCipherLength(h: ObjectHeader, i: number): number {
  const start = i * h.chunkSize;
  const plain = Math.min(h.chunkSize, Math.max(0, h.plaintextSize - start));
  return plain + TAG_BYTES;
}

/** Byte offset of chunk `i` within the object file. */
export function chunkOffset(h: ObjectHeader, headerLength: number, i: number): number {
  let off = headerLength;
  for (let k = 0; k < i; k++) off += chunkCipherLength(h, k);
  return off;
}

/**
 * Decrypt chunks lazily out of a Blob-backed object.
 *
 * Yields plaintext chunk by chunk so callers can stream into a ZIP, a hash, or a
 * Blob without ever holding the whole file twice.
 */
export async function* decryptObject(
  object: Blob,
  headerLength: number,
  header: ObjectHeader,
  fileKey: CryptoKey,
  opts: { from?: number; to?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  const from = opts.from ?? 0;
  const to = Math.min(opts.to ?? header.totalChunks, header.totalChunks);
  let off = chunkOffset(header, headerLength, from);

  for (let i = from; i < to; i++) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const len = chunkCipherLength(header, i);
    const ct = await object.slice(off, off + len).arrayBuffer();
    if (ct.byteLength !== len) {
      throw new Error(`object truncated at chunk ${i}`);
    }
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce(i) as BufferSource, additionalData: aad(header, i) as BufferSource },
      fileKey,
      ct,
    );
    off += len;
    yield new Uint8Array(plain);
  }
}

/** Streaming SHA-256 of a Blob's plaintext, for duplicate detection (§36). */
export async function hashBlob(
  source: Blob,
  opts: { onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  for (let off = 0; off < source.size || off === 0; off += CHUNK_SIZE) {
    if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const end = Math.min(off + CHUNK_SIZE, source.size);
    hasher.update(new Uint8Array(await source.slice(off, end).arrayBuffer()));
    opts.onProgress?.(end, source.size);
    if (end >= source.size) break;
  }
  return hasher.digest("hex");
}
