import type { AiHttpResponse } from "./ai-session";
import { OPENAI_ENDPOINT, validateOpenAiKey } from "./openai";
import { MAX_RESPONSE_BYTES } from "./openai-stream";
import { validChatId } from "./chat-history";

const idPattern = /^resp_[A-Za-z0-9_-]{1,180}$/;
export const backgroundStates = ["queued", "in_progress", "completed", "incomplete", "cancelled", "failed"] as const;
export type ResponseState = typeof backgroundStates[number];
export interface SavedResponseReceipt { turnId: string; responseId: string; requestNumber: number }
export interface BackgroundAccess {
  retrieve(id: string, key: string, signal?: AbortSignal, allowHidden?: boolean): Promise<AiHttpResponse>;
  cancel(id: string, key: string): Promise<AiHttpResponse>;
  wait(milliseconds: number, signal: AbortSignal, allowHidden?: boolean): Promise<void>;
}
export interface AndroidRecovery {
  access: BackgroundAccess;
  appSwitch?: { enabled(): boolean; setEnabled(value: boolean): void };
  enabled(): boolean;
  setEnabled(value: boolean): void;
}

export function readResponseReceipts(raw: unknown): SavedResponseReceipt[] {
  if (!Array.isArray(raw)) return [];
  const entries = new Map<string, SavedResponseReceipt>();
  for (const item of raw as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const { turnId, responseId, requestNumber } = item as Record<string, unknown>;
    if (typeof turnId !== "string" || !validChatId(turnId) || typeof responseId !== "string" || !idPattern.test(responseId) ||
        typeof requestNumber !== "number" || !Number.isSafeInteger(requestNumber) || requestNumber < 1) continue;
    entries.set(turnId, { turnId, responseId, requestNumber });
  }
  return [...entries.values()];
}

export function backgroundEnvelope(raw: string, expectedId?: string): { id: string; status: ResponseState } {
  if (new TextEncoder().encode(raw).length > MAX_RESPONSE_BYTES) throw Error("The background response exceeds the device size limit.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw Error("OpenAI returned an unreadable background response."); }
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (item.object !== "response" || typeof item.id !== "string" || !idPattern.test(item.id) ||
      (expectedId !== undefined && item.id !== expectedId) || !backgroundStates.some(state => state === item.status))
    throw Error("The OpenAI response identity or status could not be verified.");
  return { id: item.id, status: item.status as ResponseState };
}
export function isBackgroundPending(status: ResponseState): boolean { return status === "queued" || status === "in_progress"; }

type StatusHttp = (request: { url: string; method: "GET" | "POST"; headers: Record<string, string>; throw: false }) => Promise<AiHttpResponse>;
export function backgroundAccess(request: StatusHttp, owner: Document): BackgroundAccess {
  const call = (id: string, key: string, cancel: boolean) => {
    if (!idPattern.test(id)) throw Error("Invalid saved OpenAI response reference.");
    return request({ url: OPENAI_ENDPOINT + "/" + id + (cancel ? "/cancel" : ""), method: cancel ? "POST" : "GET",
      headers: { Authorization: "Bearer " + validateOpenAiKey(key), ...(cancel ? { "Content-Type": "application/json" } : {}) }, throw: false });
  };
  const lookups = new Map<string, { key: string; response: Promise<AiHttpResponse> }[]>();
  const lookup = (id: string, key: string) => {
    const originalKey = validateOpenAiKey(key);
    const active = lookups.get(id) ?? [];
    // A return to the app can replace a stalled check. Native requestUrl can still be finishing the old GET.
    if (active.length >= 2) {
      const matching = active.slice().reverse().find(entry => entry.key === originalKey);
      return matching?.response ?? Promise.reject(Error("Earlier status checks are still finishing. Try again in a moment."));
    }
    const response = call(id, originalKey, false);
    const entry = { key: originalKey, response };
    active.push(entry);
    lookups.set(id, active);
    const finished = () => {
      active.splice(active.indexOf(entry), 1);
      if (!active.length) lookups.delete(id);
    };
    void response.then(finished, finished);
    return response;
  };
  return {
    retrieve: (id, key, signal, allowHidden = false) => {
      if (!signal) return lookup(id, key);
      if (signal.aborted || !allowHidden && owner.visibilityState !== "visible") return Promise.reject(Error("The status check was interrupted."));
      return new Promise<AiHttpResponse>((resolve, reject) => {
        const cleanup = () => {
          signal.removeEventListener("abort", interrupted);
          owner.removeEventListener("visibilitychange", changed);
        };
        const interrupted = () => { cleanup(); reject(Error("The status check was interrupted.")); };
        const changed = () => { if (owner.visibilityState !== "visible") interrupted(); };
        signal.addEventListener("abort", interrupted, { once: true });
        if (!allowHidden) owner.addEventListener("visibilitychange", changed);
        try { lookup(id, key).then(resolve, reject).finally(cleanup); }
        catch (error) { cleanup(); reject(error instanceof Error ? error : Error("The status check was interrupted.")); }
      });
    },
    cancel: (id, key) => call(id, key, true),
    wait: (milliseconds, signal, allowHidden = false) => new Promise<void>(resolve => {
      const win = owner.defaultView;
      if (!win || signal.aborted || !allowHidden && owner.visibilityState !== "visible") { resolve(); return; }
      const done = () => {
        win.clearTimeout(timer);
        signal.removeEventListener("abort", done);
        owner.removeEventListener("visibilitychange", done);
        resolve();
      };
      const timer = win.setTimeout(done, milliseconds);
      signal.addEventListener("abort", done, { once: true });
      if (!allowHidden) owner.addEventListener("visibilitychange", done, { once: true });
    }),
  };
}
