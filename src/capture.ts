import type { YoofloeCaptureCandidate, YoofloeCaptureTarget } from "./types";

function trimCaptureText(value: string) {
  return value.replace(/\r\n/g, "\n").trim().slice(0, 5000);
}

function firstLine(text: string) {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function titleFromText(text: string, fallback: string) {
  const title = firstLine(text)
    .replace(/^[-*]\s+\[[ xX]\]\s*/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
  return (title || fallback).slice(0, 140);
}

function bodyAfterTitle(text: string) {
  const [, ...rest] = text.split("\n");
  return rest.join("\n").trim();
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function sourceSnippet(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 139)}...` : normalized;
}

export function buildLocalCaptureCandidates(textValue: string, target: YoofloeCaptureTarget): YoofloeCaptureCandidate[] {
  const text = trimCaptureText(textValue);
  if (!text) return [];

  if (target === "task") {
    const title = titleFromText(text, "Captured task");
    return [{
      candidateId: `local-${Date.now()}-task`,
      action: "schedule.task.create",
      domain: "schedule",
      menu: "Schedule",
      riskTier: "low",
      itemType: "task",
      title,
      normalizedFields: {
        scope: "personal",
        title,
        description: bodyAfterTitle(text) || null,
        dueDate: null,
        priority: null,
        type: "task"
      },
      sourceSnippet: sourceSnippet(text),
      confidence: 0.74,
      warnings: ["Connect Yoofloe to apply this candidate."],
      requiresConfirmation: false
    }];
  }

  const title = titleFromText(text, target === "journal" ? "Captured journal entry" : "Captured memo");
  return [{
    candidateId: `local-${Date.now()}-${target}`,
    action: target === "journal" ? "journal.entry.create" : "journal.memo.create",
    domain: "journal",
    menu: "Journal/Memo",
    riskTier: "low",
    itemType: target === "journal" ? "journal" : "memo",
    title,
    normalizedFields: {
      scope: "personal",
      title,
      content: text,
      type: target === "journal" ? "entry" : "memo",
      date: todayDate()
    },
    sourceSnippet: sourceSnippet(text),
    confidence: 0.74,
    warnings: ["Connect Yoofloe to apply this candidate."],
    requiresConfirmation: false
  }];
}
