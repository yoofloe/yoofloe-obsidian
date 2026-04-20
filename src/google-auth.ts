import { requestUrl } from "obsidian";
import type { YoofloeSecretStore } from "./secrets";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/generative-language.retriever"
];
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
type DesktopWindow = Window & { require?: NodeJS.Require; };

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

function requireDesktopModule<T>(specifier: string): T {
  const desktopWindow = activeWindow as DesktopWindow;
  const runtimeRequire = typeof require === "function"
    ? require
    : desktopWindow.require;

  if (!runtimeRequire) {
    throw new Error("Google OAuth is available only in the desktop Obsidian runtime.");
  }

  return runtimeRequire(specifier) as T;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return bytesToBase64Url(new Uint8Array(digest));
}

function assertGoogleClientId(clientId: string) {
  const normalized = clientId.trim();
  if (!normalized) {
    throw new Error("Add your Google OAuth desktop client ID in Settings > Yoofloe before connecting Google.");
  }
  if (!normalized.includes(".apps.googleusercontent.com")) {
    throw new Error("Google OAuth client ID must be a Desktop App client ID ending in .apps.googleusercontent.com.");
  }
  return normalized;
}

function isReconnectWorthyError(message: string) {
  return /invalid_grant|invalid_client|unauthorized_client|client id|revoked|expired/i.test(message);
}

async function postForm<TResponse>(url: string, values: Record<string, string>): Promise<TResponse> {
  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(values).toString()
  });

  if (response.status >= 400) {
    const payload = (response.json || {}) as GoogleTokenResponse;
    const text = typeof response.text === "string" ? response.text.trim() : "";
    const message = payload.error_description || payload.error || text || `Google OAuth request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return (response.json || {}) as TResponse;
}

async function exchangeCodeForTokens(args: {
  clientId: string;
  clientSecret?: string | null;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) {
  const form: Record<string, string> = {
    client_id: args.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: args.redirectUri
  };

  if (args.clientSecret?.trim()) {
    form.client_secret = args.clientSecret.trim();
  }

  return await postForm<GoogleTokenResponse>(GOOGLE_TOKEN_URL, form);
}

async function refreshAccessToken(args: {
  clientId: string;
  clientSecret?: string | null;
  refreshToken: string;
}) {
  const form: Record<string, string> = {
    client_id: args.clientId,
    grant_type: "refresh_token",
    refresh_token: args.refreshToken
  };

  if (args.clientSecret?.trim()) {
    form.client_secret = args.clientSecret.trim();
  }

  return await postForm<GoogleTokenResponse>(GOOGLE_TOKEN_URL, form);
}

async function openExternalUrl(url: string) {
  const electron = requireDesktopModule<{ shell: { openExternal: (target: string) => Promise<void> | void; }; }>("electron");
  await Promise.resolve(electron.shell.openExternal(url));
}

async function createLoopbackReceiver(state: string) {
  const authWindow = activeWindow as Window;
  const http = requireDesktopModule<typeof import("node:http")>("node:http");
  return await new Promise<{ redirectUri: string; waitForCode: () => Promise<string>; }>((resolveReceiver, rejectReceiver) => {
    let settled = false;
    let timeoutId: number | null = null;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (reason?: unknown) => void;

    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = http.createServer((req, res) => {
      const callbackUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (callbackUrl.pathname !== "/yoofloe-google-auth") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const returnedState = callbackUrl.searchParams.get("state");
      const error = callbackUrl.searchParams.get("error");
      const errorDescription = callbackUrl.searchParams.get("error_description");
      const code = callbackUrl.searchParams.get("code");

      const cleanup = () => {
        if (timeoutId !== null) {
          authWindow.clearTimeout(timeoutId);
          timeoutId = null;
        }
        server.close();
      };

      if (settled) {
        cleanup();
        return;
      }

      if (returnedState !== state) {
        settled = true;
        res.statusCode = 400;
        res.end("State mismatch. You can close this tab.");
        cleanup();
        rejectCode(new Error("Google OAuth state mismatch. Please try connecting again."));
        return;
      }

      if (error) {
        settled = true;
        res.statusCode = 400;
        res.end("Google sign-in failed. You can close this tab and return to Obsidian.");
        cleanup();
        rejectCode(new Error(errorDescription || error));
        return;
      }

      if (!code) {
        settled = true;
        res.statusCode = 400;
        res.end("Missing authorization code. You can close this tab.");
        cleanup();
        rejectCode(new Error("Google OAuth did not return an authorization code."));
        return;
      }

      settled = true;
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end("<html><body><h2>Yoofloe Google connection complete.</h2><p>You can close this tab and return to Obsidian.</p></body></html>");
      cleanup();
      resolveCode(code);
    });

    server.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        authWindow.clearTimeout(timeoutId);
        timeoutId = null;
      }
      rejectCode(error);
      rejectReceiver(error);
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        settled = true;
        server.close();
        rejectCode(new Error("Unable to allocate a local callback port for Google OAuth."));
        rejectReceiver(new Error("Unable to allocate a local callback port for Google OAuth."));
        return;
      }

      timeoutId = authWindow.setTimeout(() => {
        if (settled) return;
        settled = true;
        server.close();
        rejectCode(new Error("Google OAuth timed out before completion. Try again from Settings > Yoofloe."));
      }, AUTH_TIMEOUT_MS);

      resolveReceiver({
        redirectUri: `http://127.0.0.1:${address.port}/yoofloe-google-auth`,
        waitForCode: () => codePromise
      });
    });
  });
}

function buildAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}) {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: args.clientId,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    include_granted_scopes: "true",
    prompt: "consent",
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    state: args.state
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export class YoofloeGoogleAuthManager {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly secretStore: YoofloeSecretStore) {}

  hasRefreshToken() {
    return !!this.secretStore.getGoogleRefreshToken();
  }

  clearSession() {
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.secretStore.clearGoogleRefreshToken();
  }

  async checkConnection(clientIdInput: string, clientSecretInput?: string | null) {
    if (!this.secretStore.getGoogleRefreshToken()) {
      return "not-connected" as const;
    }

    if (!clientIdInput.trim()) {
      return "reconnect" as const;
    }

    try {
      await this.getAccessToken(clientIdInput, clientSecretInput);
      return "connected" as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google OAuth refresh failed.";
      return isReconnectWorthyError(message) ? "reconnect" as const : "connected" as const;
    }
  }

  async connect(clientIdInput: string, clientSecretInput?: string | null) {
    const clientId = assertGoogleClientId(clientIdInput);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const state = randomBase64Url(24);
    const receiver = await createLoopbackReceiver(state);
    const authUrl = buildAuthorizationUrl({
      clientId,
      redirectUri: receiver.redirectUri,
      state,
      codeChallenge
    });

    await openExternalUrl(authUrl);
    const code = await receiver.waitForCode();
    const tokenResponse = await exchangeCodeForTokens({
      clientId,
      clientSecret: clientSecretInput,
      code,
      codeVerifier,
      redirectUri: receiver.redirectUri
    });

    if (!tokenResponse.refresh_token?.trim()) {
      throw new Error("Google OAuth did not return a refresh token. Ensure you are using a Desktop App OAuth client and try again.");
    }

    if (!tokenResponse.access_token?.trim()) {
      throw new Error("Google OAuth did not return an access token.");
    }

    this.secretStore.setGoogleRefreshToken(tokenResponse.refresh_token);
    if (!this.secretStore.getGoogleRefreshToken()) {
      throw new Error("Google sign-in completed, but Obsidian secure storage did not keep the session. Restart Obsidian and connect Google again.");
    }
    this.accessToken = tokenResponse.access_token;
    this.accessTokenExpiresAt = Date.now() + Math.max((tokenResponse.expires_in || 3600) - 60, 60) * 1000;
  }

  async getAccessToken(clientIdInput: string, clientSecretInput?: string | null) {
    const clientId = assertGoogleClientId(clientIdInput);
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const refreshToken = this.secretStore.getGoogleRefreshToken();
    if (!refreshToken) {
      throw new Error("Connect your Google account in Settings > Yoofloe before running Google AI commands.");
    }

    try {
      const tokenResponse = await refreshAccessToken({
        clientId,
        clientSecret: clientSecretInput,
        refreshToken
      });

      if (!tokenResponse.access_token?.trim()) {
        throw new Error("Google OAuth refresh did not return an access token.");
      }

      this.accessToken = tokenResponse.access_token;
      this.accessTokenExpiresAt = Date.now() + Math.max((tokenResponse.expires_in || 3600) - 60, 60) * 1000;
      return this.accessToken;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Google OAuth refresh failed.";
      if (/invalid_grant/i.test(message)) {
        this.clearSession();
        throw new Error("Google OAuth session expired or was revoked. Reconnect Google in Settings > Yoofloe.");
      }
      if (/invalid_client|unauthorized_client/i.test(message)) {
        throw new Error("Your Google OAuth client ID is invalid for this app. Save the correct Desktop App client ID in Settings > Yoofloe and connect Google again.");
      }
      throw error;
    }
  }
}
