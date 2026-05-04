const ENVELOPE_VERSION = 2;
const ENVELOPE_APP = "yoofloe";
const AES_GCM_ALGORITHM = "AES-GCM-256";
const AES_GCM_WEBCRYPTO_NAME = "AES-GCM";
const AES_256_KEY_BYTES = 32;
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BITS = 128;
const RECOVERY_KEY_PREFIX = "yf-rec-";

export type EncryptionEnvelopeV2Aad = {
  table: string;
  row_id: string;
  field: string;
  user_id?: string;
  scope: "personal" | "couple" | "shared";
  shared_group_id?: string;
  schema_version: number;
};

export type EncryptionEnvelopeV2 = {
  v: 2;
  app: "yoofloe";
  alg: "AES-GCM-256";
  key_scope: "user" | "shared_group";
  kid: string;
  dek_id?: string;
  nonce: string;
  aad: EncryptionEnvelopeV2Aad;
  ct: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getCryptoApi(): Crypto {
  if (!crypto?.subtle || typeof crypto.getRandomValues !== "function") {
    throw new Error("[EncryptionEnvelopeV2] WebCrypto is not available.");
  }
  return crypto;
}

function assertNoUndefined(value: unknown, path = "value"): void {
  if (value === undefined) {
    throw new TypeError(`[EncryptionEnvelopeV2] ${path} cannot be undefined.`);
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoUndefined(entry, `${path}[${index}]`));
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    assertNoUndefined(entry, `${path}.${key}`);
  });
}

export function canonicalJson(value: unknown): string {
  assertNoUndefined(value);
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function bytesToBinary(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return binary;
}

export function base64UrlEncode(input: Uint8Array | ArrayBuffer | ArrayBufferView): string {
  const bytes = normalizeBytes(input, "base64UrlEncode input");
  return btoa(bytesToBinary(bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError("[EncryptionEnvelopeV2] Invalid base64url value.");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function normalizeBytes(
  input: Uint8Array | ArrayBuffer | ArrayBufferView | string,
  name = "key material"
): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string") return base64UrlDecode(input);
  throw new TypeError(`[EncryptionEnvelopeV2] ${name} must be bytes or base64url.`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export function generateKeyMaterial(): string {
  const bytes = new Uint8Array(AES_256_KEY_BYTES);
  getCryptoApi().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function generateRecoveryKey(): string {
  return `${RECOVERY_KEY_PREFIX}${generateKeyMaterial()}`;
}

export function recoveryKeyToKeyMaterial(recoveryKey: string): string {
  if (!recoveryKey.startsWith(RECOVERY_KEY_PREFIX)) {
    throw new TypeError("[EncryptionEnvelopeV2] Recovery key has an invalid prefix.");
  }
  const keyMaterial = recoveryKey.slice(RECOVERY_KEY_PREFIX.length);
  if (base64UrlDecode(keyMaterial).byteLength !== AES_256_KEY_BYTES) {
    throw new TypeError("[EncryptionEnvelopeV2] Recovery key must contain 256 bits.");
  }
  return keyMaterial;
}

async function importAesGcmKey(keyMaterial: string | Uint8Array, keyUsages: KeyUsage[]): Promise<CryptoKey> {
  const keyBytes = normalizeBytes(keyMaterial, "AES-GCM key material");
  if (keyBytes.byteLength !== AES_256_KEY_BYTES) {
    throw new TypeError("[EncryptionEnvelopeV2] AES-GCM-256 key material must be 32 bytes.");
  }
  return getCryptoApi().subtle.importKey("raw", toArrayBuffer(keyBytes), { name: AES_GCM_WEBCRYPTO_NAME }, false, keyUsages);
}

function aadBytes(aad: unknown): Uint8Array {
  return textEncoder.encode(canonicalJson(aad));
}

export async function encryptBytesAesGcm(input: {
  plaintextBytes: Uint8Array | ArrayBuffer | ArrayBufferView;
  keyMaterial: string | Uint8Array;
  aad: unknown;
  nonceBytes?: Uint8Array | string;
}): Promise<{ nonce: string; ct: string }> {
  const nonce = input.nonceBytes
    ? normalizeBytes(input.nonceBytes, "AES-GCM nonce")
    : (() => {
        const generated = new Uint8Array(AES_GCM_NONCE_BYTES);
        getCryptoApi().getRandomValues(generated);
        return generated;
      })();
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) {
    throw new TypeError("[EncryptionEnvelopeV2] AES-GCM nonce must be 96 bits.");
  }
  const key = await importAesGcmKey(input.keyMaterial, ["encrypt"]);
  const ciphertext = await getCryptoApi().subtle.encrypt(
    {
      name: AES_GCM_WEBCRYPTO_NAME,
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(aadBytes(input.aad)),
      tagLength: AES_GCM_TAG_BITS
    },
    key,
    toArrayBuffer(normalizeBytes(input.plaintextBytes, "plaintext bytes"))
  );
  return { nonce: base64UrlEncode(nonce), ct: base64UrlEncode(new Uint8Array(ciphertext)) };
}

export async function decryptBytesAesGcm(input: {
  ciphertext: string | Uint8Array;
  keyMaterial: string | Uint8Array;
  aad: unknown;
  nonce: string | Uint8Array;
}): Promise<Uint8Array> {
  const key = await importAesGcmKey(input.keyMaterial, ["decrypt"]);
  const plaintext = await getCryptoApi().subtle.decrypt(
    {
      name: AES_GCM_WEBCRYPTO_NAME,
      iv: toArrayBuffer(normalizeBytes(input.nonce, "AES-GCM nonce")),
      additionalData: toArrayBuffer(aadBytes(input.aad)),
      tagLength: AES_GCM_TAG_BITS
    },
    key,
    toArrayBuffer(normalizeBytes(input.ciphertext, "ciphertext bytes"))
  );
  return new Uint8Array(plaintext);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateEnvelopeAad(aad: unknown): aad is EncryptionEnvelopeV2Aad {
  if (!isPlainObject(aad)) return false;
  if (!aad.table || !aad.row_id || !aad.field || !aad.scope) return false;
  if (!Number.isInteger(aad.schema_version)) return false;
  if (aad.scope === "personal" && !aad.user_id) return false;
  if ((aad.scope === "couple" || aad.scope === "shared") && !aad.shared_group_id) return false;
  return ["personal", "couple", "shared"].includes(aad.scope as string);
}

export function validateEncryptionEnvelopeV2(value: unknown): value is EncryptionEnvelopeV2 {
  if (!isPlainObject(value)) return false;
  return value.v === ENVELOPE_VERSION
    && value.app === ENVELOPE_APP
    && value.alg === AES_GCM_ALGORITHM
    && ["user", "shared_group"].includes(value.key_scope as string)
    && typeof value.kid === "string"
    && value.kid.length > 0
    && (value.dek_id === undefined || typeof value.dek_id === "string")
    && typeof value.nonce === "string"
    && typeof value.ct === "string"
    && validateEnvelopeAad(value.aad);
}

export function parseEncryptionEnvelopeV2(value: unknown): EncryptionEnvelopeV2 | null {
  if (validateEncryptionEnvelopeV2(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return validateEncryptionEnvelopeV2(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function looksLikeEncryptionEnvelopeV2(value: unknown): boolean {
  return parseEncryptionEnvelopeV2(value) !== null;
}

export function serializeEncryptionEnvelopeV2(envelope: EncryptionEnvelopeV2): string {
  if (!validateEncryptionEnvelopeV2(envelope)) {
    throw new TypeError("[EncryptionEnvelopeV2] Invalid v2 envelope.");
  }
  return JSON.stringify(envelope);
}

function assertExpectedAad(envelopeAad: EncryptionEnvelopeV2Aad, expectedAad?: EncryptionEnvelopeV2Aad): void {
  if (expectedAad && canonicalJson(envelopeAad) !== canonicalJson(expectedAad)) {
    throw new Error("[EncryptionEnvelopeV2] Envelope AAD does not match expected context.");
  }
}

export async function decryptStringFromEnvelopeV2(input: {
  envelope: EncryptionEnvelopeV2 | string;
  keyMaterial: string | Uint8Array;
  expectedAad?: EncryptionEnvelopeV2Aad;
}): Promise<string> {
  const parsed = parseEncryptionEnvelopeV2(input.envelope);
  if (!parsed) throw new TypeError("[EncryptionEnvelopeV2] Invalid v2 envelope.");
  assertExpectedAad(parsed.aad, input.expectedAad);
  const plaintextBytes = await decryptBytesAesGcm({
    ciphertext: parsed.ct,
    keyMaterial: input.keyMaterial,
    aad: parsed.aad,
    nonce: parsed.nonce
  });
  return textDecoder.decode(plaintextBytes);
}

export async function wrapKeyMaterialV2(input: {
  keyMaterial: string | Uint8Array;
  wrappingKeyMaterial: string | Uint8Array;
  aad: unknown;
  nonceBytes?: Uint8Array | string;
}): Promise<{ nonce: string; ct: string }> {
  return encryptBytesAesGcm({
    plaintextBytes: normalizeBytes(input.keyMaterial, "key material to wrap"),
    keyMaterial: input.wrappingKeyMaterial,
    aad: input.aad,
    nonceBytes: input.nonceBytes
  });
}

export async function unwrapKeyMaterialV2(input: {
  wrappedKey: string;
  wrappingKeyMaterial: string | Uint8Array;
  aad: unknown;
  nonce: string;
}): Promise<string> {
  const keyBytes = await decryptBytesAesGcm({
    ciphertext: input.wrappedKey,
    keyMaterial: input.wrappingKeyMaterial,
    aad: input.aad,
    nonce: input.nonce
  });
  if (keyBytes.byteLength !== AES_256_KEY_BYTES) {
    throw new Error("[EncryptionEnvelopeV2] Unwrapped key material is not 256 bits.");
  }
  return base64UrlEncode(keyBytes);
}

export async function unwrapUserRootKeyWithRecoveryKey(input: {
  wrappedKey: string;
  recoveryKey: string;
  aad: unknown;
  nonce: string;
}): Promise<string> {
  return unwrapKeyMaterialV2({
    wrappedKey: input.wrappedKey,
    wrappingKeyMaterial: recoveryKeyToKeyMaterial(input.recoveryKey),
    aad: input.aad,
    nonce: input.nonce
  });
}
