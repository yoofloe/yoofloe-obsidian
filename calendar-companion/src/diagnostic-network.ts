import { OpenAiStreamLimitError } from "./openai-stream";
import { networkErrorCodes, type DiagnosticDetail, type DiagnosticRun, type DiagnosticStage, type DiagnosticReason } from "./diagnostics";

function fields(error: unknown): Record<string, unknown> {
  return error && typeof error === "object" ? error as Record<string, unknown> : {};
}
function safeStatus(value: unknown): number | undefined {
  if (typeof value === "number" || typeof value === "string" && /^[1-5]\d{2}$/.test(value)) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
}
const aliases: readonly [RegExp, NonNullable<DiagnosticDetail["errorCode"]>][] = [
  [/\b(?:UnknownHostException|Unable to resolve host)\b/i, "UNKNOWN_HOST"],
  [/\b(?:SocketTimeoutException|TimeoutError|timed out|timeout)\b/i, "SOCKET_TIMEOUT"],
  [/\b(?:SSLHandshakeException|ERR_SSL_[A-Z_]+)\b/i, "TLS_HANDSHAKE"],
  [/\b(?:SSLPeerUnverifiedException|ERR_CERT_[A-Z_]+|certificate verify failed)\b/i, "TLS_CERTIFICATE"],
  [/\b(?:AbortError|cancelled|canceled)\b/i, "ABORTED"],
  [/\b(?:EOFException|unexpected end of stream)\b/i, "UNEXPECTED_EOF"],
  [/\b(?:connection reset|broken pipe)\b/i, "ECONNRESET"],
  [/\bnetwork is unreachable\b/i, "ENETUNREACH"],
  [/\bconnection refused\b/i, "ECONNREFUSED"],
];
const reasonByCode: Record<NonNullable<DiagnosticDetail["errorCode"]>, DiagnosticReason> = {
  UNKNOWN_HOST: "dns", ENOTFOUND: "dns", EAI_AGAIN: "dns", ERR_NAME_NOT_RESOLVED: "dns",
  ETIMEDOUT: "timeout", ESOCKETTIMEDOUT: "timeout", ERR_TIMED_OUT: "timeout", ERR_CONNECTION_TIMED_OUT: "timeout", SOCKET_TIMEOUT: "timeout",
  UNEXPECTED_EOF: "stream_incomplete", TLS_HANDSHAKE: "tls", TLS_CERTIFICATE: "tls", ECONNREFUSED: "unreachable", ENETUNREACH: "unreachable", EHOSTUNREACH: "unreachable",
  ERR_CONNECTION_REFUSED: "unreachable", ERR_ADDRESS_UNREACHABLE: "unreachable", ERR_INTERNET_DISCONNECTED: "offline",
  ECONNRESET: "connection_reset", EPIPE: "connection_reset", ERR_CONNECTION_RESET: "connection_reset",
  ERR_CONNECTION_ABORTED: "connection_reset", ERR_CONNECTION_CLOSED: "connection_reset", ERR_NETWORK_CHANGED: "connection_reset",
  ERR_ABORTED: "aborted", ECANCELED: "aborted", ABORTED: "aborted",
};

/** Read known error shapes privately. Only fixed codes and numeric status leave this function. */
export function diagnoseTransport(error: unknown): DiagnosticDetail {
  if (error instanceof OpenAiStreamLimitError) return { reason: "response_invalid", evidence: "runtime_error" };
  try {
    let current = error, observed: DiagnosticDetail | undefined;
    for (let depth = 0; depth < 4 && current; depth++) {
      const value = fields(current);
      const raw = typeof current === "string" ? current.slice(0, 512) :
        typeof value.message === "string" ? value.message.slice(0, 512) : "";
      const httpStatus = safeStatus(value.status ?? value.statusCode) ?? safeStatus(fields(value.response).status) ??
        safeStatus(/^\s*(?:Error: )?Request failed, status ([1-5]\d{2})\.?\s*$/i.exec(raw)?.[1]);
      if (httpStatus !== undefined)
        return { reason: httpStatus >= 200 && httpStatus < 300 ? "response_unconfirmed" : "http", evidence: "http_response", httpStatus };
      if (!observed) {
        const hint = [value.code, value.name, raw].filter(part => typeof part === "string").map(part => String(part).slice(0, 512)).join(" ");
        const code = networkErrorCodes.find(item => new RegExp("\\b" + item + "\\b", "i").test(hint)) ??
          aliases.find(([pattern]) => pattern.test(hint))?.[1];
        if (code) observed = { reason: reasonByCode[code], evidence: "runtime_error", errorCode: code };
      }
      current = value.cause;
    }
    return observed ?? { reason: "unknown", evidence: "observation_unavailable" };
  } catch { return { reason: "unknown", evidence: "observation_unavailable" }; }
}

export function responseDiagnostics(response: { status: number; headers?: Readonly<Record<string, string>> }): DiagnosticDetail {
  const headers = response.headers ?? {};
  const lookup = (name: string) => {
    const key = Object.keys(headers).find(value => value.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  };
  const providerId = lookup("x-request-id"), elapsed = lookup("openai-processing-ms");
  return { evidence: "http_response", httpStatus: response.status,
    ...(providerId && /^req_[a-f0-9]{16,80}$/i.test(providerId) ? { providerId, remoteConfirmed: true } : {}),
    providerProcessingMs: elapsed && /^\d{1,8}$/.test(elapsed) ? Number(elapsed) : undefined };
}
const successful = (status: number): boolean => status >= 200 && status < 300;

export async function observeHttp<T extends { status: number; headers?: Readonly<Record<string, string>> }>(
  run: DiagnosticRun | undefined, stage: DiagnosticStage, info: DiagnosticDetail, send: () => Promise<T>,
  accepted: (status: number) => boolean = successful, stoppedWhileWaiting?: () => boolean,
): Promise<T> {
  if (!run) return send();
  const attempt = run.nextAttempt(), start = performance.now();
  const before = run.sampleDevice();
  run.event(stage, "started", { ...info, ...before, attempt });
  const sequence = run.report.events.at(-1)?.sequence ?? 0;
  try {
    const response = await send();
    const ok = accepted(response.status);
    run.event(stage, ok ? "received" : "failed", { ...info, ...run.sampleDevice(), attempt, elapsedMs: Math.round(performance.now() - start),
      ...responseDiagnostics(response), reason: ok ? undefined : "http" });
    return response;
  } catch (error) {
    if (stoppedWhileWaiting?.()) {
      run.event(stage, "stopped", { ...info, ...run.sampleDevice(), reason: "aborted", attempt, elapsedMs: Math.round(performance.now() - start) });
      throw error;
    }
    const diagnosis = diagnoseTransport(error);
    const httpUnconfirmed = (info.transport === "obsidian_http_stream" || info.transport === "android_webview_stream" || info.transport === "openai_background") &&
      (diagnosis.reason === "unknown" || diagnosis.reason === "response_unconfirmed");
    const after = run.sampleDevice();
    const appHiddenDuringRequest = stage === "model_request" && (before?.visible === false || after?.visible === false ||
      run.report.events.some(event => event.sequence > sequence &&
        (event.stage === "visibility" || event.stage === "session") && event.visible === false));
    run.event(stage, httpUnconfirmed ? "unconfirmed" : "failed", {
      ...info, ...after, attempt, elapsedMs: Math.round(performance.now() - start), ...diagnosis,
      reason: httpUnconfirmed ? "response_unconfirmed" : diagnosis.reason, appHiddenDuringRequest,
    });
    throw error;
  }
}
