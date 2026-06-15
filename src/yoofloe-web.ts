import { requestUrl } from "obsidian";

const YOOFLOE_WEB_BASE_URL = "https://www.yoofloe.com";

export const YOOFLOE_WEB_PAIRING_URL = `${YOOFLOE_WEB_BASE_URL}/settings`;
export const YOOFLOE_PAIRING_PENDING_CONTRACT = "Browser pairing opens Yoofloe web, lets you sign in there with Google or email/password, and returns only a short-lived Obsidian PAT to this plugin. Obsidian never collects your Yoofloe password.";

type DesktopWindow = Window & { require?: NodeJS.Require; };

export type YoofloePairingSession = {
  pairingId: string;
  verifier: string;
  verificationUrl: string;
  expiresAt: string;
};

export type YoofloePairingClaim = {
  token: string;
  tokenId?: string;
  maskedToken?: string;
  expiresAt?: string;
  status?: string;
};

function requireDesktopModule<T>(specifier: string): T {
  const desktopWindow = activeWindow as DesktopWindow;
  const runtimeRequire = typeof require === "function"
    ? require
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

export async function openYoofloeWebPairing(targetUrl = YOOFLOE_WEB_PAIRING_URL) {
  const electron = requireDesktopModule<{ shell: { openExternal: (target: string) => Promise<void> | void; }; }>("electron");
  await Promise.resolve(electron.shell.openExternal(targetUrl));
}

export async function startYoofloeWebPairingSession(functionsBaseUrl: string): Promise<YoofloePairingSession> {
  const verifier = randomVerifier();
  const verifierHash = await sha256Hex(verifier);
  const response = await postPairingJson<{
    pairingId?: string;
    verificationUrl?: string;
    expiresAt?: string;
  }>(functionsBaseUrl, "start-obsidian-pairing", {
    verifierHash,
    label: "Obsidian plugin pairing"
  });

  if (!response.pairingId || !response.verificationUrl || !response.expiresAt) {
    throw new Error("Yoofloe pairing start response was incomplete.");
  }

  return {
    pairingId: response.pairingId,
    verifier,
    verificationUrl: response.verificationUrl,
    expiresAt: response.expiresAt
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
