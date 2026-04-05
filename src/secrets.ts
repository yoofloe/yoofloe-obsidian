import { requireApiVersion, type App } from "obsidian";
import type { YoofloePluginSettings } from "./types";

const SECRET_IDS = {
  pat: "yoofloe-pat",
  googleClientSecret: "yoofloe-google-cs",
  googleRefreshToken: "yoofloe-google-rt",
  googleRefreshTokenLegacy: "yoofloe-google-refresh-token"
} as const;

export const SECRET_STORAGE_REQUIRED_MESSAGE = "Yoofloe secure token storage requires Obsidian 1.11.5 or newer.";

function normalizeSecret(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function describeStoredSecret(value: string | null, prefixChars = 0) {
  const secret = normalizeSecret(value);
  if (!secret) return "Not configured";

  const suffix = secret.slice(-4);
  if (prefixChars > 0 && secret.length > prefixChars) {
    return `${secret.slice(0, prefixChars)}****...${suffix}`;
  }

  return `Configured (...${suffix})`;
}

export class YoofloeSecretStore {
  readonly isAvailable: boolean;

  constructor(private readonly app: App) {
    this.isAvailable = requireApiVersion("1.11.5")
      && typeof app.secretStorage?.setSecret === "function"
      && typeof app.secretStorage?.getSecret === "function";
  }

  private getSecret(id: string) {
    if (!this.isAvailable) return null;
    return normalizeSecret(this.app.secretStorage.getSecret(id));
  }

  private setSecret(id: string, value: string) {
    if (!this.isAvailable) {
      throw new Error(SECRET_STORAGE_REQUIRED_MESSAGE);
    }

    this.app.secretStorage.setSecret(id, value.trim());
  }

  getPat() {
    return this.getSecret(SECRET_IDS.pat);
  }

  setPat(value: string) {
    this.setSecret(SECRET_IDS.pat, value);
  }

  clearPat() {
    if (!this.isAvailable) return;
    this.app.secretStorage.setSecret(SECRET_IDS.pat, "");
  }

  getGoogleRefreshToken() {
    return this.getSecret(SECRET_IDS.googleRefreshToken)
      || this.getSecret(SECRET_IDS.googleRefreshTokenLegacy);
  }

  getGoogleClientSecret() {
    return this.getSecret(SECRET_IDS.googleClientSecret);
  }

  setGoogleClientSecret(value: string) {
    this.setSecret(SECRET_IDS.googleClientSecret, value);
  }

  clearGoogleClientSecret() {
    if (!this.isAvailable) return;
    this.app.secretStorage.setSecret(SECRET_IDS.googleClientSecret, "");
  }

  setGoogleRefreshToken(value: string) {
    this.setSecret(SECRET_IDS.googleRefreshToken, value);
  }

  clearGoogleRefreshToken() {
    if (!this.isAvailable) return;
    this.app.secretStorage.setSecret(SECRET_IDS.googleRefreshToken, "");
    this.app.secretStorage.setSecret(SECRET_IDS.googleRefreshTokenLegacy, "");
  }
}

export function migrateLegacySecretsFromSettings(settings: YoofloePluginSettings, secretStore: YoofloeSecretStore) {
  if (!secretStore.isAvailable) return false;

  let dirty = false;
  const legacyPat = settings.apiToken.trim();

  if (legacyPat) {
    secretStore.setPat(legacyPat);
    settings.apiToken = "";
    dirty = true;
  }

  return dirty;
}
