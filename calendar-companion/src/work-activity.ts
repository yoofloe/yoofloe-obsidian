import { containsCredential } from "./agent-policy";

export type ActivityKind = "status" | "request" | "response" | "tool" | "blocked" | "summary" | "follow-up";
export type ActivityState = "working" | "done" | "waiting" | "blocked";
export interface WorkEvent {
  id: number;
  at: number;
  kind: ActivityKind;
  state: ActivityState;
  text: string;
}
export interface SteerNote { id: string; text: string }

export const WORK_ACTIVITY_LIMIT = 100;

export function workText(text: string, maximum = 1000): string {
  if (containsCredential(text)) return "Sensitive details were omitted.";
  return text.trim().slice(0, maximum);
}

export function readActivity(value: unknown, maximum = WORK_ACTIVITY_LIMIT): WorkEvent[] {
  if (!Array.isArray(value)) return [];
  const events: WorkEvent[] = [];
  for (const entry of value.slice(-maximum) as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { id, at, kind, state, text } = entry as Record<string, unknown>;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0 ||
      typeof at !== "number" || !Number.isFinite(at) || typeof text !== "string" ||
      !["status", "request", "response", "tool", "blocked", "summary", "follow-up"].includes(String(kind)) ||
      !["working", "done", "waiting", "blocked"].includes(String(state))) continue;
    events.push({ id, at, kind: kind as ActivityKind, state: state as ActivityState, text: workText(text) });
  }
  return events;
}

export function readSteerNotes(value: unknown): SteerNote[] {
  if (!Array.isArray(value)) return [];
  const notes: SteerNote[] = [];
  for (const entry of value.slice(-20) as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { id, text } = entry as Record<string, unknown>;
    if (typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id) && typeof text === "string")
      notes.push({ id, text: workText(text, 32000) });
  }
  return notes;
}

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return minutes < 60 ? `${minutes}:${remainder}` :
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}
