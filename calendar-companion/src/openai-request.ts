import type { AiHttpResponse, AiTransport } from "./ai-session";
import { OPENAI_ENDPOINT } from "./openai";

interface RequestTrace {
  clientId: string;
  bytes: number;
  started: number;
}

function stringField(error: Record<string, unknown>, name: string): string {
  const value = error[name];
  return typeof value === "string" ? value.slice(0, 512) : "";
}

function transportFailure(error: unknown): string {
  const fields = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = fields.status ?? fields.statusCode;
  if (typeof status === "number" && Number.isInteger(status) && status >= 300 && status <= 599)
    return `failed with HTTP ${status} reported by Obsidian`;
  const message = typeof error === "string" ? error.slice(0, 512) : stringField(fields, "message");
  const reported = /^\s*(?:Error: )?Request failed, status ([345]\d{2})\.?\s*$/i.exec(message);
  if (reported) return `failed with HTTP ${reported[1]} reported by Obsidian`;
  const hint = [stringField(fields, "name"), stringField(fields, "code"), message].join(" ");
  if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|SocketTimeoutException|TimeoutError|timed out|timeout)\b/i.test(hint))
    return "timed out before an HTTP response was available";
  if (/\b(?:UnknownHostException|Unable to resolve host|ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED)\b/i.test(hint))
    return "could not resolve the OpenAI host";
  if (/\b(?:SSLHandshakeException|SSLPeerUnverifiedException|ERR_CERT_[A-Z_]+|ERR_SSL_[A-Z_]+|certificate verify failed)\b/i.test(hint))
    return "could not establish a secure connection";
  if (/\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ERR_(?:CONNECTION_REFUSED|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED)|connection refused|network is unreachable)\b/i.test(hint))
    return "could not connect to OpenAI";
  if (/\b(?:ECONNRESET|EPIPE|ERR_(?:CONNECTION_(?:RESET|ABORTED|CLOSED)|NETWORK_CHANGED)|connection reset|broken pipe|unexpected end of stream)\b/i.test(hint))
    return "lost its network connection before the response could be confirmed";
  if (/\b(?:AbortError|ERR_ABORTED|ECANCELED|cancelled|canceled)\b/i.test(hint))
    return "was interrupted before the response could be confirmed";
  return "ended before Obsidian returned an HTTP response";
}

function header(headers: AiHttpResponse["headers"], name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find(entry => entry.toLowerCase() === name);
  return key === undefined ? undefined : headers?.[key];
}

function traceText(trace: RequestTrace, response?: AiHttpResponse): string {
  const requestId = header(response?.headers, "x-request-id");
  const processing = header(response?.headers, "openai-processing-ms");
  const elapsed = Math.max(0, Math.round(performance.now() - trace.started));
  const parts = ["Obsidian HTTP", `${elapsed} ms`, `${trace.bytes} B`];
  if (response) parts.push(`HTTP ${response.status}`);
  parts.push(`client ID ${trace.clientId}`);
  // Keep the local ID when a proxy or the provider supplies an unexpected header.
  if (requestId && /^req_[a-f0-9]{32}$/i.test(requestId)) parts.push(`OpenAI ID ${requestId}`);
  if (processing && /^\d{1,8}$/.test(processing)) parts.push(`OpenAI ${processing} ms`);
  return parts.join(" · ");
}

/** Only the outbound request carries the key and input. Activity records use bounded metadata. */
export async function requestOpenAiRound(
  transport: AiTransport, body: string, key: string, number: number, bytes: number,
): Promise<{ response: AiHttpResponse; trace: string }> {
  const trace = { clientId: crypto.randomUUID(), bytes, started: performance.now() };
  let response: AiHttpResponse;
  try {
    response = await transport({ url: OPENAI_ENDPOINT, method: "POST", contentType: "application/json", body, throw: false,
      headers: { Authorization: "Bearer " + key, "X-Client-Request-Id": trace.clientId } });
  } catch (error) {
    throw Error(`OpenAI request ${number} ${transportFailure(error)}. No retry was made. The request may still incur charges. (${traceText(trace)})`);
  }
  return { response, trace: traceText(trace, response) };
}
