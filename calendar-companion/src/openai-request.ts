import type { AiHttpResponse, AiTransport } from "./ai-session";
import { OPENAI_ENDPOINT } from "./openai";
import type { DiagnosticDetail, DiagnosticReason, DiagnosticRun } from "./diagnostics";
import { diagnoseTransport, observeHttp } from "./diagnostic-network";

const OPENAI_HOST = new URL(OPENAI_ENDPOINT).hostname;
const DNS_FAILURE = "could not resolve the OpenAI host";

const recoverableTransportReasons = new Set<DiagnosticReason>(["dns", "timeout", "offline", "unreachable", "connection_reset", "aborted", "unknown"]);

export class OpenAiConnectionPause extends Error {
  constructor(message: string, readonly reason: DiagnosticReason, readonly deliveryUnconfirmed: boolean) {
    super(message);
  }
}

interface RequestTrace {
  clientId: string;
  bytes: number;
  started: number;
  streamed: boolean;
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

function traceText(trace: RequestTrace, response?: AiHttpResponse): string {
  const requestId = header(response?.headers, "x-request-id");
  const processing = header(response?.headers, "openai-processing-ms");
  const elapsed = Math.max(0, Math.round(performance.now() - trace.started));
  const parts = [trace.streamed ? "Obsidian HTTP stream" : "Obsidian HTTP", `${elapsed} ms`, `${trace.bytes} B`];
  if (response) parts.push(`HTTP ${response.status}`);
  parts.push(`client ID ${trace.clientId}`);
  // Keep the local ID when a proxy or the provider supplies an unexpected header.
  if (requestId && /^req_[a-f0-9]{32}$/i.test(requestId)) parts.push(`OpenAI ID ${requestId}`);
  if (processing && /^\d{1,8}$/.test(processing)) parts.push(`OpenAI ${processing} ms`);
  return parts.join(" · ");
}

/** Best-effort Android screen lock. Acquiring it never delays the API request. */
export function holdRequestScreen(wakeLock?: WakeLock): (() => void) | undefined {
  if (!wakeLock) return;
  let held: WakeLockSentinel | undefined;
  let finished = false;
  void (async () => {
    try {
      const lock = await wakeLock.request("screen");
      if (finished) await lock.release();
      else held = lock;
    } catch { /* Android or the WebView may decline a screen wake lock. */ }
  })();
  return () => {
    if (finished) return;
    finished = true;
    if (held && !held.released) void held.release().catch(() => {});
  };
}

/** Only the outbound request carries the key and input. Activity records use bounded metadata. */
export async function requestOpenAiRound(
  transport: AiTransport, body: string, key: string, number: number, bytes: number, streamed = false,
  diagnostics?: DiagnosticRun, inputTokens?: number,
): Promise<{ response: AiHttpResponse; trace: string }> {
  const trace = { clientId: crypto.randomUUID(), bytes, started: performance.now(), streamed };
  let response: AiHttpResponse;
  try {
    response = await observeHttp(diagnostics, "model_request", {
      requestNumber: number, requestBytes: bytes, inputTokens, clientId: trace.clientId, transport: streamed ? "obsidian_http_stream" : "obsidian_http",
    }, () => transport({ url: OPENAI_ENDPOINT, method: "POST", contentType: "application/json", body, throw: false,
      headers: { Authorization: "Bearer " + key, "X-Client-Request-Id": trace.clientId } }));
  } catch (error) {
    const diagnosis = diagnoseTransport(error);
    const message = `OpenAI request ${number} ${describeTransportFailure(diagnosis)}.`;
    const details = traceText(trace);
    const reason = diagnosis.reason ?? "unknown";
    if (reason === "dns" && confirmedOpenAiLookupFailure(error))
      throw new OpenAiConnectionPause(`${message} (${details})`, "dns", false);
    const responseUnconfirmed = reason === "response_unconfirmed" ||
      (diagnosis.httpStatus === undefined && recoverableTransportReasons.has(reason));
    if (streamed && responseUnconfirmed) {
      const lastFailure = diagnostics?.report.lastFailure;
      const hidden = lastFailure?.clientId === trace.clientId && lastFailure.appHiddenDuringRequest === true;
      const lifecycle = hidden ? " Obsidian was hidden while the request was pending." : "";
      throw new OpenAiConnectionPause(`${message}${lifecycle} This request may still incur charges. (${details})`,
        reason === "unknown" ? "response_unconfirmed" : reason, true);
    }
    throw Error(`${message} No retry was made by the plugin. The request may still incur charges. (${details})`);
  }
  return { response, trace: traceText(trace, response) };
}
