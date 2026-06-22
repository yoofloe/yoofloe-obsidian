import { Platform, requestUrl } from "obsidian";

const YOOFLOE_WEB_BASE_URL = "https://www.yoofloe.com";

export const YOOFLOE_WEB_PAIRING_URL = `${YOOFLOE_WEB_BASE_URL}/settings`;
export const YOOFLOE_PAIRING_PENDING_CONTRACT = "Browser pairing opens Yoofloe web, lets you sign in there with Google or email/password, and returns only a short-lived Obsidian PAT to this plugin. Obsidian never collects your Yoofloe password.";

type RuntimeRequire = (specifier: string) => unknown;
type DesktopWindow = Window & { require?: RuntimeRequire; };

export type YoofloeExternalOpenResult = {
  url: string;
  opened: boolean;
  copied: boolean;
  message: string;
};

export type YoofloePairingSession = {
  pairingId: string;
  verifier: string;
  verificationUrl: string;
  expiresAt: string;
  requestedCapabilities?: string[];
};

export type YoofloePairingClaim = {
  token: string;
  tokenId?: string;
  maskedToken?: string;
  expiresAt?: string;
  status?: string;
  scope?: string;
  capabilities?: string[];
};

export type YoofloePairingAccess = "read" | "read-write";

const YOOFLOE_READ_WRITE_CAPABILITIES = [
  "obsidian:read",
  "obsidian:write:capture",
  "obsidian:write:journal",
  "obsidian:write:schedule",
  "obsidian:write:goals",
  "obsidian:write:study",
  "obsidian:write:activity",
  "obsidian:write:wellness",
  "obsidian:write:exercise",
  "obsidian:write:business",
  "obsidian:write:finance",
  "obsidian:write:delete"
];

function requireDesktopModule<T>(specifier: string): T {
  const desktopWindow = activeWindow as DesktopWindow;
  const runtimeRequire = typeof require === "function"
    ? require as RuntimeRequire
    : desktopWindow.require;

  if (!runtimeRequire) {
    throw new Error("Opening Yoofloe web is available only in the desktop Obsidian runtime.");
  }

  return runtimeRequire(specifier) as T;
}

function normalizeBaseUrl(functionsBaseUrl: string) {
  return (functionsBaseUrl || "").trim().replace(/\/+$/, "");
}

function joinUrl(functionsBaseUrl: string, path: string) {
  const base = normalizeBaseUrl(functionsBaseUrl);
  if (!base) {
    throw new Error("Yoofloe functions base URL is missing.");
  }
  return `${base}/${path.replace(/^\/+/, "")}`;
}

function randomVerifier() {
  const bytes = new Uint8Array(32);
  activeWindow.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await activeWindow.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function postPairingJson<T>(functionsBaseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await requestUrl({
    url: joinUrl(functionsBaseUrl, path),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = response.json as Record<string, unknown> | null;

  if (response.status >= 400) {
    const message = typeof payload?.error === "string"
      ? payload.error
      : `Yoofloe pairing request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return (payload || {}) as T;
}

async function copyUrlToClipboard(targetUrl: string) {
  try {
    const clipboard = activeWindow.navigator.clipboard;
    if (!clipboard?.writeText) {
      return false;
    }

    await clipboard.writeText(targetUrl);
    return true;
  } catch {
    return false;
  }
}

export async function openYoofloeWebPairing(targetUrl = YOOFLOE_WEB_PAIRING_URL): Promise<YoofloeExternalOpenResult> {
  if (Platform.isDesktopApp) {
    const electron = requireDesktopModule<{ shell: { openExternal: (target: string) => Promise<void> | void; }; }>("electron");
    await Promise.resolve(electron.shell.openExternal(targetUrl));
    return {
      url: targetUrl,
      opened: true,
      copied: false,
      message: "Yoofloe web opened. Approve the pairing request, then return to Obsidian."
    };
  }

  try {
    const openedWindow = activeWindow.open(targetUrl, "_blank", "noopener,noreferrer");
    if (openedWindow) {
      return {
        url: targetUrl,
        opened: true,
        copied: false,
        message: "Yoofloe web opened. Approve the pairing request, then return to Obsidian."
      };
    }
  } catch {
    // Fall through to clipboard/manual fallback.
  }

  const copied = await copyUrlToClipboard(targetUrl);
  return {
    url: targetUrl,
    opened: false,
    copied,
    message: copied
      ? "Yoofloe pairing link copied. Open it in your browser, approve access, then return to Obsidian."
      : `Open this Yoofloe pairing link in your browser, approve access, then return to Obsidian: ${targetUrl}`
  };
}

function requestedCapabilitiesForAccess(access: YoofloePairingAccess) {
  return access === "read-write"
    ? YOOFLOE_READ_WRITE_CAPABILITIES
    : ["obsidian:read"];
}

export async function startYoofloeWebPairingSession(
  functionsBaseUrl: string,
  access: YoofloePairingAccess = "read"
): Promise<YoofloePairingSession> {
  const verifier = randomVerifier();
  const verifierHash = await sha256Hex(verifier);
  const requestedCapabilities = requestedCapabilitiesForAccess(access);
  const response = await postPairingJson<{
    pairingId?: string;
    verificationUrl?: string;
    expiresAt?: string;
    requestedCapabilities?: string[];
  }>(functionsBaseUrl, "start-obsidian-pairing", {
    verifierHash,
    label: access === "read-write" ? "Obsidian Capture write access" : "Obsidian plugin pairing",
    access,
    capabilities: requestedCapabilities
  });

  if (!response.pairingId || !response.verificationUrl || !response.expiresAt) {
    throw new Error("Yoofloe pairing start response was incomplete.");
  }

  return {
    pairingId: response.pairingId,
    verifier,
    verificationUrl: response.verificationUrl,
    expiresAt: response.expiresAt,
    requestedCapabilities: response.requestedCapabilities || requestedCapabilities
  };
}

export async function claimYoofloeWebPairing(
  functionsBaseUrl: string,
  session: Pick<YoofloePairingSession, "pairingId" | "verifier">
): Promise<YoofloePairingClaim | null> {
  const response = await postPairingJson<YoofloePairingClaim>(
    functionsBaseUrl,
    "claim-obsidian-pairing",
    {
      pairingId: session.pairingId,
      verifier: session.verifier
    }
  );

  if (response.status === "pending") {
    return null;
  }

  if (!response.token?.startsWith("pat_yfl_")) {
    throw new Error("Yoofloe pairing completed without a valid Obsidian token.");
  }

  return response;
}

export async function waitForYoofloeWebPairing(
  functionsBaseUrl: string,
  session: YoofloePairingSession,
  {
    intervalMs = 2500,
    timeoutMs = 180000
  }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<YoofloePairingClaim> {
  const expiresAt = new Date(session.expiresAt).getTime();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline && (!Number.isFinite(expiresAt) || Date.now() < expiresAt)) {
    const claim = await claimYoofloeWebPairing(functionsBaseUrl, session);
    if (claim) return claim;

    await new Promise((resolve) => {
      activeWindow.setTimeout(resolve, intervalMs);
    });
  }

  throw new Error("Yoofloe web pairing timed out. Start pairing again from Obsidian settings.");
}
