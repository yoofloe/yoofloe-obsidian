const terminalStatus = new Map([
  ["response.completed", "completed"], ["response.incomplete", "incomplete"],
  ["response.failed", "failed"], ["response.cancelled", "cancelled"],
]);

function unconfirmed(): Error {
  return Error("The OpenAI stream ended before the result was confirmed. No retry was made by the plugin. The request may still incur charges.");
}

function finalEvent(name: string, lines: string[]): string | undefined {
  if (!lines.length) return;
  let event: { type?: string; response?: { status?: string }; code?: unknown } | null;
  try { event = JSON.parse(lines.join("\n")) as typeof event; }
  catch { if (name === "error" || terminalStatus.has(name)) throw unconfirmed(); else return; }
  const kind = event?.type;
  if (kind === "error" && (!name || name === kind)) return JSON.stringify({ status: "failed", error: { code: event?.code } });
  if (!kind || !terminalStatus.has(kind)) {
    if (terminalStatus.has(name)) throw unconfirmed();
    return;
  }
  const response = event?.response;
  if ((name && name !== kind) || response?.status !== terminalStatus.get(kind)) throw unconfirmed();
  return JSON.stringify(response);
}

/** Obsidian delivers the buffered SSE body. Only a complete terminal event authorizes tool work. */
export function openAiStreamResult(raw: string): string {
  if (raw.trimStart().startsWith("{")) return raw; // A complete JSON response is still valid.
  const lines = /\r\n|[\r\n]/g;
  let offset = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  lines.lastIndex = offset;
  let type = "", data: string[] = [], end: RegExpExecArray | null;
  while ((end = lines.exec(raw))) {
    const length = end.index - offset;
    if (!length) {
      const result = finalEvent(type, data);
      if (result !== undefined) return result;
      type = ""; data = [];
    } else if (raw.startsWith("event:", offset)) {
      type = raw.slice(offset + 6, end.index).trim();
    } else if ((!type || type === "error" || terminalStatus.has(type)) && raw.startsWith("data:", offset)) {
      const start = offset + 5;
      data.push(raw.slice(raw[start] === " " ? start + 1 : start, end.index));
    }
    offset = lines.lastIndex;
  }
  throw unconfirmed();
}
