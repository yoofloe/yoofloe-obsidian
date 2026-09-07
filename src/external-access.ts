import type { YoofloeAccessStatusResponse, YoofloeExternalAccessSecurityContract } from "./types";

/** Returns a checked server contract without granting new local key capabilities. */
export function parseSecurityContract(value: unknown): YoofloeExternalAccessSecurityContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Yoofloe security contract is missing. Update the server and plugin before continuing.");
  }
  const contract = value as Record<string, unknown>;
  if (contract.schemaVersion !== 2 && contract.schemaVersion !== 3) {
    throw new Error("Yoofloe security contract is unsupported. Update the plugin before continuing.");
  }
  const expected = {
    scope: "personal", coupleScopeEnabled: false,
    encryptionMode: "mixed_legacy_v1_and_zke_v2", zkeAtRestMode: "zke_client_decrypt",
    legacyServerDerivedKeyStatus: "migration_only", requiresLocalKeyForV2: true,
    canReadCiphertext: true, canReadZkePlaintext: false, plaintextExportConsentRequired: true,
    patCanDecrypt: false, mcpConfigCanDecrypt: false, rawKeyStorageAllowed: false, serverCanDecryptV2: false
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (contract[key] !== expectedValue) throw new Error("Yoofloe security contract does not match personal PAT access.");
  }
  if (contract.schemaVersion === 3) {
    const surfaces = contract.surfaces as Record<string, Record<string, unknown>> | undefined;
    for (const surface of ["obsidian_plugin", "obsidian_mcp"]) {
      const entry = surfaces?.[surface];
      if (!entry || entry.authMode !== "pat" || entry.scope !== "personal" || entry.canReadZkePlaintext !== false) {
        throw new Error("Yoofloe security contract does not match this Obsidian surface.");
      }
    }
  }
  return contract as unknown as YoofloeExternalAccessSecurityContract;
}

/** Maps server denial codes to actionable messages without exposing response bodies. */
export function describeAccessError(status: number, code?: string): string {
  switch (code) {
    case "TOKEN_EXPIRED": return "Your Yoofloe token expired. Reconnect Yoofloe in Settings.";
    case "TOKEN_REVOKED": return "Your Yoofloe token was revoked. Reconnect Yoofloe in Settings.";
    case "TOKEN_SCOPE_INSUFFICIENT": return "This token does not permit that action. Review Yoofloe access in Settings.";
    case "EXTERNAL_AI_ACCESS_REQUIRED":
    case "EXTERNAL_AI_ACCESS_CONSENT_REQUIRED":
    case "EXTERNAL_AI_CONSENT_REQUIRED":
    case "AI_TERMS_REQUIRED": return "Review the current External AI Access notice in Yoofloe Settings.";
    case "EXTERNAL_ACCESS_DISABLED": return "External Yoofloe access is temporarily disabled. Try again later.";
    case "CLIENT_UPDATE_REQUIRED": return "Connection diagnostics require an updated Yoofloe server. No personal data was requested.";
    case "CONNECTION_CHANGED": return "The Yoofloe connection changed. Discard this result and try again.";
    case "RATE_LIMITED": return "Yoofloe access is rate limited. Try again shortly.";
    default: break;
  }
  if (status === 401) return "Yoofloe authentication failed. Reconnect Yoofloe in Settings.";
  if (status === 403) return "Yoofloe access is blocked. Review account eligibility and permissions in Yoofloe Settings.";
  if (status === 429) return "Yoofloe access is rate limited. Try again shortly.";
  if (status >= 500) return "Yoofloe is temporarily unavailable. Try again shortly.";
  return status > 0 ? `Yoofloe request failed with status ${status}.` : "Yoofloe could not be reached. Check the connection and try again.";
}

/** Validates the status-only response; an older data response is never a diagnostic fallback. */
export function parseAccessStatus(value: unknown): YoofloeAccessStatusResponse {
  const status = value as Partial<YoofloeAccessStatusResponse> | null;
  if (!status || status.kind !== "obsidian-access-status" || status.success !== true
    || typeof status.generatedAt !== "string" || !Number.isFinite(Date.parse(status.generatedAt))
    || typeof status.entitlement?.allowed !== "boolean"
    || !Array.isArray(status.capabilities) || !status.capabilities.every((entry) => typeof entry === "string")
    || "bundle" in status) {
    throw new Error("Yoofloe returned an unsupported access status. Update the server before verifying this connection.");
  }
  parseSecurityContract(status.security);
  return status as YoofloeAccessStatusResponse;
}

export class YoofloeConnectionChangedError extends Error {
  readonly code = "CONNECTION_CHANGED";
  constructor() { super(describeAccessError(0, "CONNECTION_CHANGED")); }
}
