import type { AiHttpRequest, AiHttpResponse } from "./ai-session";
import { OPENAI_ENDPOINT } from "./openai";
import { MAX_RESPONSE_BYTES, OpenAiEventDecoder, OpenAiStreamLimitError, type StreamResult } from "./openai-stream";

export type HttpReceipt = Pick<AiHttpResponse, "status" | "headers">;
export interface StreamHttpResponse extends AiHttpResponse { terminal?: StreamResult }
export type AndroidModelStream = (request: AiHttpRequest, received: (receipt: HttpReceipt) => void, lifetime?: AbortSignal) => Promise<StreamHttpResponse>;

function safeReceipt(response: Response): HttpReceipt {
  const headers: Record<string, string> = {};
  for (const name of ["x-request-id", "openai-processing-ms"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, headers };
}

/** requestUrl buffers until HTTP EOF. A direct Android stream can commit a complete Responses event before then. */
export function createAndroidModelStream(runtime: Pick<Window, "fetch">): AndroidModelStream | undefined {
  if (typeof runtime.fetch !== "function" || typeof Response === "undefined" || !("body" in Response.prototype) ||
      typeof ReadableStream === "undefined" || typeof TextDecoder === "undefined" || typeof AbortController === "undefined") return;
  return async (request, received, lifetime) => {
    if (request.url !== OPENAI_ENDPOINT || request.method !== "POST") throw Error("Invalid OpenAI Responses endpoint.");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (lifetime?.aborted) cancel();
    else lifetime?.addEventListener("abort", cancel, { once: true });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let receipt: HttpReceipt | undefined;
    try {
      const response = await runtime.fetch(OPENAI_ENDPOINT, {
        method: "POST", headers: { ...request.headers, "Content-Type": request.contentType, Accept: "text/event-stream" },
        body: request.body, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
        cache: "no-store", mode: "cors", signal: abort.signal,
      });
      receipt = safeReceipt(response);
      received(receipt);
      if (!response.body) {
        if (!response.ok) return { ...receipt, text: "" };
        throw Error("The OpenAI response body was unavailable.");
      }
      reader = response.body.getReader();
      const utf8 = new TextDecoder(), events = new OpenAiEventDecoder(), textParts: string[] = [];
      let format: "text" | "events" | undefined = response.ok ? undefined : "text";
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (format !== "text") events.finish();
          textParts.push(utf8.decode());
          return { ...receipt, text: textParts.join("") };
        }
        bytes += chunk.value.byteLength;
        const text = utf8.decode(chunk.value, { stream: true });
        if (!format) {
          const first = text.trimStart()[0];
          if (first) format = first === "{" ? "text" : "events";
        }
        if (format === "events") {
          const terminal = events.push(text);
          if (terminal) return { ...receipt, text: terminal.text, terminal };
        } else {
          if (bytes > MAX_RESPONSE_BYTES) {
            if (!response.ok) return { ...receipt, text: "" };
            throw new OpenAiStreamLimitError();
          }
          if (format === "text") textParts.push(text);
        }
      }
    } catch (error) {
      if (!receipt || error instanceof OpenAiStreamLimitError) throw error;
      if (receipt.status < 200 || receipt.status >= 300) return { ...receipt, text: "" };
      throw Object.assign(Error("The OpenAI response stream ended before completion."), { status: receipt.status, cause: error });
    } finally {
      lifetime?.removeEventListener("abort", cancel);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      abort.abort();
    }
  };
}
