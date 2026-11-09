import { type Delivery, type DeliveryV3, type RecordSnapshot } from "./protocol";
import { type AiDraft, type AiProvider } from "./ai-session";
import { recordLabel } from "./record-types";
const encoder = new TextEncoder();
export interface NoteStore {
  exists(path: string): Promise<boolean>; read(path: string): Promise<string>;
  mkdir(path: string): Promise<void>; create(path: string, text: string): Promise<void>;
}

/** Render imported user text literally, without remote images, HTML or active embeds. */
function literal(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\\`*_[\]{}()!#|]/g, "\\$&");
}

/** Preserve source dates as civil values rather than converting them to UTC. */
export async function renderRecord(datasetId: string, record: RecordSnapshot): Promise<string> {
  const canonical = { id: record.id, kind: record.kind, sourceId: record.sourceId, revision: record.revision, title: record.title, text: record.text, date: record.date };
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(canonical)))), b => b.toString(16).padStart(2, "0")).join("");
  const header = `---\nyoofloe_calendar: 2\nsource_dataset: "${datasetId}"\nsource_kind: "${record.kind}"\nsource_id: "${record.id}"\nsource_native_id: ${JSON.stringify(record.sourceId)}\nsource_revision: ${record.revision}\nsource_sha256: "${hash}"\n---\n\n`;
  return header + `# ${literal(record.title || "Untitled")}\n\n${literal(recordLabel(record.kind))} snapshot${record.date ? ` · ${record.date}` : ""}.\n\n`
    + "Changes to this note do not change Calendar or Flow rewards.\n\n" + literal(record.text) + "\n";
}

/** Preflight all conflicts before writing; create-only paths make retry safe after an interrupted batch. */
export async function saveDelivery(delivery: Delivery, store: NoteStore, guard: () => void): Promise<{ created: number; skipped: number }> {
  guard();
  if (delivery.version !== 2) throw Error("Search excerpts cannot be saved as full snapshots. Use the manual import to save complete records.");
  const planned = [];
  for (const record of delivery.records) {
    const path = `Yoofloe Calendar/Snapshots v2/${delivery.datasetId}/${record.kind}-${record.id}-r${record.revision}.md`;
    const text = await renderRecord(delivery.datasetId, record); guard();
    const exists = await store.exists(path); guard();
    if (exists && await store.read(path) !== text) throw Error("An imported note was edited or its source changed. Existing notes were kept; no new notes were written.");
    guard(); planned.push({ path, text, exists });
  }
  if (planned.some(item => !item.exists)) {
    guard(); await store.mkdir("Yoofloe Calendar"); guard(); await store.mkdir("Yoofloe Calendar/Snapshots v2"); guard(); await store.mkdir(`Yoofloe Calendar/Snapshots v2/${delivery.datasetId}`);
  }
  let created = 0;
  for (const item of planned) {
    guard();
    if (!item.exists) { await store.create(item.path, item.text); created++; }
  }
  return { created, skipped: planned.length - created };
}

/** Save an explicitly accepted AI draft as a new literal note; never update source records. */
export async function saveAiDraft(draft: AiDraft, store: NoteStore, guard: () => void, provider: AiProvider = "openai", source?: { question: string; delivery: DeliveryV3 }): Promise<string> {
  guard();
  const path = `Yoofloe Calendar/AI drafts/${crypto.randomUUID()}.md`;
  const provenance = source ? `\n## Calendar sources\n\nQuestion: ${literal(source.question)}\n\nAs of ${new Date(source.delivery.exportedAt).toISOString()} (${literal(source.delivery.context.zone)}). ${source.delivery.context.partial ? "Partial results; totals cover observed matches only." : "Bounded search of the requested workspaces and dates."}\n\n`
    + source.delivery.records.map((record, i) => `- C${i + 1}: ${literal(record.title || "Untitled")} · ${literal(recordLabel(record.kind))}${record.date ? ` · ${record.date}` : ""}`).join("\n") + "\n" : "";
  const text = `---\nyoofloe_calendar_ai_draft: 1\nincomplete: ${draft.incomplete}\n---\n\n# ${provider === "gemini" ? "Gemini" : "OpenAI"} draft\n\nAI-generated text. Review for accuracy. This note does not change Calendar or Flow rewards.\n\n${literal(draft.text)}\n${provenance}`;
  await store.mkdir("Yoofloe Calendar"); guard();
  await store.mkdir("Yoofloe Calendar/AI drafts"); guard();
  await store.create(path, text);
  return path;
}
