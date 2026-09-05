/**
 * Device unlock via the WebAuthn PRF extension (§18–§22).
 *
 * Plain WebAuthn authentication is *not* sufficient to recover a key: "the
 * authenticator said yes" is a boolean, and a boolean cannot decrypt anything.
 * Only PRF gives us a stable high-entropy secret bound to the credential, so
 * without it there is nothing to build on and the feature is simply refused
 * (§63.6 — no silent downgrade to storing a retrievable master key).
 *
 * WebAuthn needs the DOM and a user gesture, so it runs here on the main thread.
 * The PRF output is key material and transits this thread by necessity; it is
 * handed straight to the worker and dropped. It never becomes a stored value.
 */

export class PrfUnsupportedError extends Error {
  constructor() {
    super("This browser or device can't derive an unlock secret securely.");
    this.name = "PrfUnsupportedError";
  }
}

export interface Enrollment {
  credentialId: Uint8Array;
  prfOutput: Uint8Array;
}

const RP_NAME = "Local Vault";
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decodeB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const encodeB64url = b64url;

type PrfExtension = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

function prfResult(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as PrfExtension;
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/**
 * Create a platform credential and obtain its PRF output.
 *
 * Some authenticators report `prf.enabled` at creation but only produce a value
 * during an assertion, so a second `get()` is a normal part of enrolment rather
 * than an error path.
 */
export async function enrollDevice(
  vaultId: Uint8Array,
  prfSalt: Uint8Array,
): Promise<Enrollment> {
  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: RP_NAME, id: location.hostname },
      user: { id: vaultId as BufferSource, name: "vault", displayName: RP_NAME },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 60_000,
      attestation: "none",
      extensions: {
        prf: { eval: { first: prfSalt as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new PrfUnsupportedError();
  const credentialId = new Uint8Array(created.rawId);

  const ext = created.getClientExtensionResults() as PrfExtension;
  if (!ext.prf?.enabled && !ext.prf?.results?.first) throw new PrfUnsupportedError();

  const direct = prfResult(created);
  if (direct) return { credentialId, prfOutput: direct };

  const prfOutput = await evaluatePrf(credentialId, prfSalt);
  return { credentialId, prfOutput };
}

/** Ask the authenticator to evaluate the PRF for an existing credential. */
export async function evaluatePrf(
  credentialId: Uint8Array,
  prfSalt: Uint8Array,
): Promise<Uint8Array> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: credentialId as BufferSource }],
      userVerification: "required",
      timeout: 60_000,
      extensions: {
        prf: { eval: { first: prfSalt as BufferSource } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new PrfUnsupportedError();
  const output = prfResult(assertion);
  // Reached only when the authenticator authenticated but produced no secret —
  // exactly the case that must fail rather than fall back to something weaker.
  if (!output) throw new PrfUnsupportedError();
  return output;
}

/** Best-effort pre-check. A definitive answer only comes from enrolment (§20.5). */
export async function looksAvailable(): Promise<boolean> {
  if (typeof globalThis.PublicKeyCredential === "undefined") return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}
