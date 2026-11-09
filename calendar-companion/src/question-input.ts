import type { DeliveryV3 } from "./protocol";
import { validateQuestionContext } from "./question-query";
const encoder = new TextEncoder();

/** Exact outbound content. Local source identities, vault paths and unused workspaces are excluded. */
export function buildQuestionInput(delivery: DeliveryV3, question: string): string {
  if (!question.trim() || encoder.encode(question).length > 4000 || !delivery.records.length) throw Error("Find relevant records before generating a draft.");
  const context = validateQuestionContext(delivery.context, delivery.context.scope, delivery.records.length);
  return JSON.stringify({ request: question.trim(), context: {
    workspaces: context.scope.areas, period: { from: context.from, through: context.through, zone: context.zone },
    as_of: new Date(delivery.exportedAt).toISOString(), coverage: context.partial ? "partial: totals describe only observed matching records" : "bounded search of the requested workspaces and dates",
    scanned: context.scanned, matched: context.matched, totals: context.metrics,
    meaning: "Study totals are recorded study seconds. Garden totals are measured focus seconds. Neither is a planned duration. Study and Garden can overlap; do not add them as independent time. Excerpts and totals may cover different record counts. Cite source references; do not infer missing details.",
  }, calendar_records: delivery.records.map((record, i) => ({ reference: `C${i + 1}`, kind: record.kind, title: record.title, text: record.text, date: record.date })) });
}

/** A digest of the exact visible outbound input, independent of mutable UI state. */
export async function inputDigest(input: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
