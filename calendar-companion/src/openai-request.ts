import type { AiHttpRequest, AiHttpResponse, AiTransport } from "./ai-session";
import type { AndroidModelStream, HttpReceipt, StreamHttpResponse } from "./android-model-stream";
import { OpenAiStreamLimitError } from "./openai-stream";
import { OPENAI_ENDPOINT, isOpenAiServerError } from "./openai";
import type { DiagnosticDetail, DiagnosticReason, DiagnosticRun } from "./diagnostics";
import { diagnoseTransport, observeHttp, responseDiagnostics } from "./diagnostic-network";

const OPENAI_HOST = new URL(OPENAI_ENDPOINT).hostname;
const DNS_FAILURE = "could not resolve the OpenAI host";

const recoverableTransportReasons = new Set<DiagnosticReason>(["dns", "timeout", "offline", "unreachable", "connection_reset", "stream_incomplete", "aborted", "unknown"]);

export class OpenAiConnectionPause extends Error {
  constructor(message: string, readonly reason: DiagnosticReason, readonly deliveryUnconfirmed: boolean, readonly nativeOnContinue = false) {
    super(message);
  }
}

export class OpenAiServerPause extends Error {}

interface RequestTrace {
  clientId: string;
  bytes: number;
  started: number;
  transport: "obsidian_http" | "obsidian_http_stream" | "android_webview_stream" | "openai_background";
}

function stringField(error: Record<string, unknown>, name: string): string {
  const value = error[name];
  return typeof value === "string" ? value.slice(0, 512) : "";
}

function describeTransportFailure({ reason, httpStatus }: DiagnosticDetail): string {
  if (httpStatus !== undefined && httpStatus >= 200 && httpStatus < 300)
    return `returned HTTP ${httpStatus} without a usable confirmation`;
  if (httpStatus !== undefined && httpStatus >= 300)
    return `failed with HTTP ${httpStatus} reported by Obsidian`;
  switch (reason) {
    case "timeout": return "timed out before an HTTP response was available";
    case "dns": return DNS_FAILURE;
    case "tls": return "could not establish a secure connection";
    case "unreachable":
    case "offline": return "could not connect to OpenAI";
    case "connection_reset": return "lost its network connection before the response could be confirmed";
    case "stream_incomplete": return "ended before the final response could be confirmed";
    case "aborted": return "was interrupted before the response could be confirmed";
    default: return "ended before Obsidian returned an HTTP response";
  }
}

export function openAiTransportFailure(error: unknown): string {
  return describeTransportFailure(diagnoseTransport(error));
}

function confirmedOpenAiLookupFailure(error: unknown): boolean {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = fields.status ?? fields.statusCode;
  if (fields.response || (typeof status === "number" || typeof status === "string") && /^[1-5]\d{2}$/.test(String(status))) return false;
  const message = typeof error === "string" ? error.slice(0, 512) : stringField(fields, "message");
  const android = /\bUnable to resolve host\s+["']?([a-z0-9.-]+)["']?(?=\s|:|$)/i.exec(message);
  const system = /\bgetaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\s+([a-z0-9.-]+)(?=\s|$)/i.exec(message);
  const hostname = stringField(fields, "hostname") || android?.[1] || system?.[1];
  return hostname?.toLowerCase() === OPENAI_HOST;
}

function header(headers: AiHttpResponse["headers"], name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find(entry => entry.toLowerCase() === name);
  return key === undefined ? undefined : headers?.[key];
}

function traceText(trace: RequestTrace, response?: HttpReceipt): string {
  const requestId = header(response?.headers, "x-request-id");
  const processing = header(response?.headers, "openai-processing-ms");
  const elapsed = Math.max(0, Math.round(performance.now() - trace.started));
  const label = trace.transport === "openai_background" ? "OpenAI background response" : trace.transport === "android_webview_stream" ? "Android WebView stream" :
    trace.transport === "obsidian_http_stream" ? "Obsidian HTTP stream" : "Obsidian HTTP";
  const parts = [label, `${elapsed} ms`, `${trace.bytes} B`];
  if (response) parts.push(`HTTP ${response.status}`);
  parts.push(`client ID ${trace.clientId}`);
  // Keep the local ID when a proxy or the provider supplies an unexpected header.
  if (requestId && /^req_[a-f0-9]{32}$/i.test(requestId)) parts.push(`OpenAI ID ${requestId}`);
  if (processing && /^\d{1,8}$/.test(processing)) parts.push(`OpenAI ${processing} ms`);
  return parts.join(" · ");
}

/** Hold the visible screen during an active Android task. The platform can decline or revoke the lock. */
export function holdRequestScreen(wakeLock?: WakeLock, owner?: Document): (() => void) | undefined {
  if (!wakeLock) return;
  let held: WakeLockSentinel | undefined, acquiring = false, finished = false, generation = 0;
  const release = () => {
    generation++;
    acquiring = false;
    const lock = held;
    held = undefined;
    if (lock && !lock.released) void lock.release().catch(() => {});
  };
  const onVisibility = () => {
    if (finished) return;
    if (owner && owner.visibilityState !== "visible") { release(); return; }
    if (acquiring || (held && !held.released)) return;
    const current = generation;
    acquiring = true;
    void (async () => {
      try {
        const lock = await wakeLock.request("screen");
        if (generation === current) held = lock;
        else await lock.release();
      } catch { /* Acquiring a screen lock is optional. */ }
      finally { if (generation === current) acquiring = false; }
    })();
  };
  owner?.addEventListener("visibilitychange", onVisibility);
  onVisibility();
  return () => {
    if (finished) return;
    finished = true;
    owner?.removeEventListener("visibilitychange", onVisibility);
    release();
  };
}

/** Only the outbound request carries the key and input. Activity records use bounded metadata. */
export async function requestOpenAiRound(
  transport: AiTransport, body: string, key: string, number: number, bytes: number,
  options: { streamed: boolean; background?: boolean; directStream?: AndroidModelStream; lifetime?: AbortSignal; diagnostics?: DiagnosticRun; inputTokens?: number },
): Promise<{ response: StreamHttpResponse; trace: string }> {
  const { streamed, diagnostics, inputTokens } = options;
  const direct = streamed ? options.directStream : undefined;
  const trace: RequestTrace = { clientId: crypto.randomUUID(), bytes, started: performance.now(),
    transport: options.background ? "openai_background" : direct ? "android_webview_stream" : streamed ? "obsidian_http_stream" : "obsidian_http" };
  const info = { requestNumber: number, requestBytes: bytes, inputTokens, clientId: trace.clientId, transport: trace.transport };
  const request: AiHttpRequest = { url: OPENAI_ENDPOINT, method: "POST", contentType: "application/json", body, throw: false,
    headers: { Authorization: "Bearer " + key, "X-Client-Request-Id": trace.clientId } };
  let response: StreamHttpResponse, receipt: HttpReceipt | undefined;
  try {
    response = await observeHttp(diagnostics, "model_request", info, () => direct ? direct(request, headers => {
      receipt = headers;
      diagnostics?.event("stream", "received", { ...info, ...responseDiagnostics(headers), ...diagnostics.sampleDevice(),
        elapsedMs: Math.round(performance.now() - trace.started) });
    }, options.lifetime) : transport(request));
  } catch (error) {
    if (error instanceof OpenAiStreamLimitError) throw Error(`OpenAI request ${number} · ${error.message} (${traceText(trace, receipt)})`);
    const diagnosis = diagnoseTransport(error);
    const failure = direct && diagnosis.reason === "unknown" && !receipt ?
      "ended before the Android WebView received HTTP headers" : describeTransportFailure(diagnosis);
    const message = `OpenAI request ${number} ${failure}.`;
    const details = traceText(trace, receipt);
    const reason = diagnosis.reason ?? "unknown";
    if (reason === "dns" && confirmedOpenAiLookupFailure(error))
      throw new OpenAiConnectionPause(`${message} (${details})`, "dns", false);
    const responseUnconfirmed = reason === "response_unconfirmed" ||
      (diagnosis.httpStatus === undefined && recoverableTransportReasons.has(reason));
    if (options.background && responseUnconfirmed)
      throw Error(`${message} (${details}) The accepted response could not be verified by ID. Review saved work before starting a new task. This request may still incur charges.`);
    if (streamed && responseUnconfirmed) {
      const lastFailure = diagnostics?.report.lastFailure;
      const hidden = lastFailure?.clientId === trace.clientId && lastFailure.appHiddenDuringRequest === true;
      const lifecycle = hidden ? " Obsidian was hidden while the request was pending." : "";
      const nativeOnContinue = !!direct && !receipt && reason === "unknown" && diagnosis.httpStatus === undefined;
      throw new OpenAiConnectionPause(`${message}${lifecycle} This request may still incur charges. (${details})`,
        reason === "unknown" ? "response_unconfirmed" : reason, true, nativeOnContinue);
    }
    throw Error(`${message} No retry was made by the plugin. The request may still incur charges. (${details})`);
  }
  const details = traceText(trace, response);
  if (isOpenAiServerError(response.status, response.text))
    throw new OpenAiServerPause(`OpenAI request ${number} returned a server error. (${details})`);
  return { response, trace: details };
}
