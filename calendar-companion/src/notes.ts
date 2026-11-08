import { type Delivery, type RecordSnapshot } from "./protocol";
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
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(record)))), b => b.toString(16).padStart(2, "0")).join("");
  const header = `---\nyoofloe_calendar: 1\nsource_dataset: "${datasetId}"\nsource_kind: "${record.kind}"\nsource_id: "${record.id}"\nsource_revision: ${record.revision}\nsource_sha256: "${hash}"\n---\n\n`;
  return header + `# ${literal(record.title || "Untitled")}\n\nCalendar ${record.kind} snapshot${record.date ? ` · ${record.date}` : ""}.\n\n`
    + "Changes to this note do not change Calendar or Flow rewards.\n\n" + literal(record.text) + "\n";
}

/** Preflight all conflicts before writing; create-only paths make retry safe after an interrupted batch. */
export async function saveDelivery(delivery: Delivery, store: NoteStore, guard: () => void): Promise<{ created: number; skipped: number }> {
  guard();
  const planned = [];
  for (const record of delivery.records) {
    const path = `Yoofloe Calendar/${delivery.datasetId}/${record.kind}-${record.id}-r${record.revision}.md`;
    const text = await renderRecord(delivery.datasetId, record); guard();
    const exists = await store.exists(path); guard();
    if (exists && await store.read(path) !== text) throw Error("An imported note was edited or its source changed. Existing notes were kept; no new notes were written.");
    guard(); planned.push({ path, text, exists });
  }
  if (planned.some(item => !item.exists)) {
    guard(); await store.mkdir("Yoofloe Calendar"); guard(); await store.mkdir(`Yoofloe Calendar/${delivery.datasetId}`);
  }
  let created = 0;
  for (const item of planned) {
    guard();
    if (!item.exists) { await store.create(item.path, item.text); created++; }
  }
  return { created, skipped: planned.length - created };
}
