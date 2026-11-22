import { findOpenAiModel } from "./openai-models";

export const DIAGNOSTIC_RETENTION = 7 * 24 * 60 * 60 * 1000;
const PREFIX = "diagnostics/";
const RECORD_LIMIT = 64 * 1024 - 128;
const MAX_REPORTS = 32;
const MAX_EVENTS = 120;
const SWEEP_INTERVAL = 60 * 60 * 1000;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const keyPattern = /^diagnostics\/(\d{13})-([a-f0-9-]{36})\.json$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const areas = ["assistant", "conversation_sync", "calendar", "chronohud"] as const;
const stages = [
  "start", "prepare", "context", "compaction", "input_tokens", "model_request", "stream", "provider_reply",
  "attachment_read", "upload", "transcription", "download", "delete_upload",
  "tool", "vault_write", "journal_save", "conversation_save", "undo",
  "continue", "queue", "steer", "stop", "finish", "session", "network", "visibility",
  "sync_scan", "sync_publish", "sync_import", "sync_stop", "sync_revision", "sync_message",
  "proposal", "transfer_write", "reply_read", "reply_verify", "approval", "result_save", "result_receive",
] as const;
const outcomes = ["started", "received", "ok", "failed", "waiting", "skipped", "paused", "stopped", "interrupted", "unconfirmed", "completed"] as const;
const reasons = [
  "unknown", "dns", "tls", "timeout", "connection_reset", "offline", "unreachable", "aborted", "http",
  "stream_incomplete", "response_invalid", "response_unconfirmed", "compaction_not_returned", "stream_item_not_checked", "input_budget", "request_limit", "missing_key", "scope", "app_hidden",
  "tool_arguments", "note_reference_unavailable", "read_range",
  "version_conflict", "superseded", "already_executed", "storage", "vault_changed", "user_action",
  "no_verified_reply", "invalid_reply", "expired", "conflict", "not_found", "cancelled", "rejected",
  "revision_unavailable", "invalid_revision", "session_reopened", "pending_confirmation", "unsupported",
] as const;
const actions = [
  "send", "dequeued", "queued", "sending", "applied", "received", "enabled", "reused", "review", "clear", "lookup", "records", "capabilities",
  "undo", "status", "manual_import", "app_return", "scan", "publish", "import", "stop",
  "search_notes", "read_outline", "read_notes", "read_next", "apply_changes",
  "create_note", "create_folder", "rename_note", "update_properties", "propose_trash", "save_generated_file",
  "draft_calendar_changes", "draft_calendar_workspace_changes", "edit", "create", "rename", "trash", "folder", "asset",
] as const;
const transports = ["obsidian_http", "obsidian_http_stream", "responses_websocket", "fetch", "vault_files", "app_handoff"] as const;
const evidence = ["runtime_error", "http_response", "observation_unavailable", "verified_reply", "local_journal", "user_action"] as const;
export const networkErrorCodes = [
  "UNKNOWN_HOST", "ENOTFOUND", "EAI_AGAIN", "ERR_NAME_NOT_RESOLVED", "ETIMEDOUT", "ESOCKETTIMEDOUT",
  "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "SOCKET_TIMEOUT", "TLS_HANDSHAKE", "TLS_CERTIFICATE",
  "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ERR_CONNECTION_REFUSED", "ERR_ADDRESS_UNREACHABLE",
  "ERR_INTERNET_DISCONNECTED", "ECONNRESET", "EPIPE", "ERR_CONNECTION_RESET", "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED", "ERR_NETWORK_CHANGED", "ERR_ABORTED", "ECANCELED", "ABORTED",
] as const;

export type DiagnosticArea = typeof areas[number];
export type DiagnosticStage = typeof stages[number];
export type DiagnosticOutcome = typeof outcomes[number];
export type DiagnosticReason = typeof reasons[number];
export type DiagnosticTransport = typeof transports[number];
export interface DiagnosticDetail {
  reason?: DiagnosticReason;
  action?: string;
  transport?: DiagnosticTransport;
  evidence?: typeof evidence[number];
  errorCode?: typeof networkErrorCodes[number];
  requestBytes?: number;
  dataBytes?: number;
  elapsedMs?: number;
  httpStatus?: number;
  requestNumber?: number;
  attempt?: number;
  clientId?: string;
  providerId?: string;
  count?: number;
  inputTokens?: number;
  outputTokens?: number;
  thresholdTokens?: number;
  model?: string;
  effort?: string;
  readScope?: string;
  writeScope?: string;
  requestLimit?: number | "none";
  reference?: string;
  relatedRun?: string;
  operationId?: string;
  online?: boolean;
  visible?: boolean;
  appHiddenDuringRequest?: boolean;
  contextReused?: boolean;
  remoteConfirmed?: boolean;
  providerProcessingMs?: number;
}
interface DiagnosticEvent extends DiagnosticDetail {
  sequence: number;
  at: number;
  stage: DiagnosticStage;
  outcome: DiagnosticOutcome;
}
interface DiagnosticEnvironment {
  plugin: string;
  obsidian: string;
  platform: "android" | "ios" | "windows" | "macos" | "linux" | "other";
}
interface ChangeSummary { confirmed: number; pending: number; reverted: number }
export interface DiagnosticReport {
  schema: 1;
  id: string;
  area: DiagnosticArea;
  startedAt: number;
  updatedAt: number;
  environment: DiagnosticEnvironment;
  outcome: DiagnosticOutcome;
  nextAction: "wait" | "continue" | "raise_limit" | "review" | "check_result" | "none";
  events: DiagnosticEvent[];
  omitted: number;
  startEvent?: DiagnosticEvent;
  firstFailure?: DiagnosticEvent;
  lastFailure?: DiagnosticEvent;
  lastSuccess?: DiagnosticEvent;
  lastResume?: DiagnosticEvent;
  lastSave?: DiagnosticEvent;
  lastAppliedCompaction?: DiagnosticEvent;
  lastCompactionIssue?: DiagnosticEvent;
  changes: ChangeSummary;
  confirmedWriteSteps?: number;
  automaticRetries: number;
  manualContinuations: number;
  /** Used on this device to locate the right report. Excluded from the exported JSON. */
  conversation?: string;
  turn?: string;
}
export interface DiagnosticStorage {
  keys(prefix: string): Promise<string[]>;
  read(name: string, limit: number): Promise<ArrayBuffer | null>;
  write(records: ReadonlyMap<string, ArrayBuffer>, keepExisting?: boolean, changes?: { remove?: readonly string[] }): Promise<void>;
  discard(names: readonly string[]): Promise<void>;
}

const emptyChanges = (): ChangeSummary => ({ confirmed: 0, pending: 0, reverted: 0 });
const nextActions = ["wait", "continue", "raise_limit", "review", "check_result", "none"] as const;
const platforms = ["android", "ios", "windows", "macos", "linux", "other"] as const;
const isIssue = (value: DiagnosticOutcome) => value === "failed" || value === "unconfirmed" || value === "interrupted" || value === "paused";
const isActive = (value: DiagnosticOutcome) => value === "started" || value === "waiting";
function oneOf<T extends string>(choices: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && choices.includes(value as T) ? value as T : undefined;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && min <= value && value <= max ? value : undefined;
}
function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && value.length < 120 && pattern.test(value) ? value : undefined;
}
function environment(input: unknown): DiagnosticEnvironment {
  const value = record(input), version = /^\d{1,5}(?:\.\d{1,5}){1,3}$/;
  return { plugin: matching(value.plugin, version) ?? "unknown", obsidian: matching(value.obsidian, version) ?? "unknown",
    platform: oneOf(platforms, value.platform) ?? "other" };
}

/** Explicit projection for both recording and export. No caller-supplied strings are copied generically. */
function detail(input: unknown): DiagnosticDetail {
  const v = record(input);
  return {
    reason: oneOf(reasons, v.reason), action: oneOf(actions, v.action), transport: oneOf(transports, v.transport),
    evidence: oneOf(evidence, v.evidence), errorCode: oneOf(networkErrorCodes, v.errorCode), requestBytes: integer(v.requestBytes),
    dataBytes: integer(v.dataBytes), elapsedMs: integer(v.elapsedMs),
    httpStatus: integer(v.httpStatus, 100, 599), requestNumber: integer(v.requestNumber, 1), attempt: integer(v.attempt, 1),
    clientId: matching(v.clientId, idPattern), providerId: matching(v.providerId, /^(?:req|resp)_[a-f0-9]{16,80}$/i),
    count: integer(v.count), inputTokens: integer(v.inputTokens), outputTokens: integer(v.outputTokens), thresholdTokens: integer(v.thresholdTokens),
    model: typeof v.model === "string" ? findOpenAiModel(v.model)?.id ?? "custom" : undefined,
    effort: oneOf(["default", "none", "low", "medium", "high", "xhigh", "max"], v.effort),
    readScope: oneOf(["current", "folder", "vault", "none"], v.readScope),
    writeScope: oneOf(["current", "folder", "vault", "new", "none"], v.writeScope),
    requestLimit: v.requestLimit === "none" ? "none" : integer(v.requestLimit, 1),
    reference: matching(v.reference, /^(?:Note|File) [1-9]\d{0,4}$/),
    relatedRun: matching(v.relatedRun, idPattern), operationId: matching(v.operationId, idPattern),
    online: typeof v.online === "boolean" ? v.online : undefined,
    visible: typeof v.visible === "boolean" ? v.visible : undefined,
    appHiddenDuringRequest: v.appHiddenDuringRequest === true ? true : undefined,
    contextReused: typeof v.contextReused === "boolean" ? v.contextReused : undefined,
    remoteConfirmed: typeof v.remoteConfirmed === "boolean" ? v.remoteConfirmed : undefined,
    providerProcessingMs: integer(v.providerProcessingMs),
  };
}
function readEvent(input: unknown): DiagnosticEvent | undefined {
  const v = record(input), stage = oneOf(stages, v.stage), outcome = oneOf(outcomes, v.outcome);
  const sequence = integer(v.sequence, 1), at = integer(v.at, 0, 8640000000000000);
  if (!stage || !outcome || sequence === undefined || at === undefined) return;
  return { sequence, at, stage, outcome, ...detail(v) };
}
function selectCheckpoint(value: unknown, events: DiagnosticEvent[], matches: (event: DiagnosticEvent) => boolean): DiagnosticEvent | undefined {
  const retained = events.reduce<DiagnosticEvent | undefined>((latest, event) => matches(event) ? event : latest, undefined);
  const stored = readEvent(value);
  if (!stored || !matches(stored) || (retained && retained.sequence >= stored.sequence) || events.some(event => event.sequence === stored.sequence))
    return retained;
  return stored;
}
function readReport(input: unknown): DiagnosticReport | null {
  const v = record(input), id = matching(v.id, idPattern), area = oneOf(areas, v.area), outcome = oneOf(outcomes, v.outcome);
  const startedAt = integer(v.startedAt, 0, 8640000000000000), updatedAt = integer(v.updatedAt, 0, 8640000000000000);
  if (v.schema !== 1 || !id || !area || !outcome || startedAt === undefined || updatedAt === undefined) return null;
  const changes = record(v.changes);
  const events = Array.isArray(v.events) ? v.events.slice(-MAX_EVENTS).map(readEvent).filter(event => !!event) : [];
  return { schema: 1, id, area, startedAt, updatedAt, outcome, environment: environment(v.environment),
    nextAction: oneOf(nextActions, v.nextAction) ?? "review",
    events,
    omitted: integer(v.omitted) ?? 0, startEvent: selectCheckpoint(v.startEvent, events, event => event.stage === "start" && event.outcome === "started"),
    firstFailure: readEvent(v.firstFailure), lastFailure: readEvent(v.lastFailure), lastSuccess: readEvent(v.lastSuccess),
    lastResume: readEvent(v.lastResume), lastSave: readEvent(v.lastSave),
    lastAppliedCompaction: selectCheckpoint(v.lastAppliedCompaction, events, event => event.stage === "compaction" && event.outcome === "ok" && event.action === "applied"),
    lastCompactionIssue: selectCheckpoint(v.lastCompactionIssue, events, event => event.stage === "compaction" && isIssue(event.outcome)),
    confirmedWriteSteps: integer(v.confirmedWriteSteps),
    changes: { confirmed: integer(changes.confirmed) ?? 0, pending: integer(changes.pending) ?? 0, reverted: integer(changes.reverted) ?? 0 },
    automaticRetries: integer(v.automaticRetries) ?? 0, manualContinuations: integer(v.manualContinuations) ?? 0,
    conversation: matching(v.conversation, /^[a-zA-Z0-9_-]{1,80}$/),
    turn: matching(v.turn, /^[a-zA-Z0-9_-]{1,80}$/) };
}

export class DiagnosticRun {
  private sequence = 0;
  private attempt = 0;
  private readonly aliases = new Map<string, string>();
  private readonly journals = new Map<string, ChangeSummary>();
  private readonly journalOperations = new Map<string, string>();
  constructor(readonly report: DiagnosticReport, private readonly changed: (run: DiagnosticRun) => void, private readonly clock: () => number,
    private readonly signals?: () => Pick<DiagnosticDetail, "online" | "visible">) {}
  get id(): string { return this.report.id; }
  nextAttempt(): number { return ++this.attempt; }
  sampleDevice(): Pick<DiagnosticDetail, "online" | "visible"> | undefined {
    try {
      const observed = this.signals?.();
      return observed && { online: observed.online, visible: observed.visible };
    } catch { return undefined; }
  }
  relateConversation(id: string): void {
    this.report.conversation = matching(id, /^[a-zA-Z0-9_-]{1,80}$/);
    this.changed(this);
  }
  relateTurn(id: string): void {
    this.report.turn = matching(id, /^[a-zA-Z0-9_-]{1,80}$/);
    this.changed(this);
  }
  alias(kind: "Note" | "File", path: string): string {
    const key = kind + "/" + path;
    const existing = this.aliases.get(key);
    if (existing) return existing;
    if (this.aliases.size >= 10000) return "";
    const value = kind + " " + (this.aliases.size + 1);
    this.aliases.set(key, value);
    return value;
  }
  event(stage: DiagnosticStage, outcome: DiagnosticOutcome, info?: DiagnosticDetail): void {
    const event: DiagnosticEvent = { sequence: ++this.sequence, at: this.clock(), stage, outcome, ...detail(info) };
    const report = this.report;
    report.updatedAt = event.at;
    report.events.push(event);
    if (report.events.length > MAX_EVENTS) { report.events.shift(); report.omitted++; }
    if (stage === "start") report.startEvent = event;
    if (stage === "vault_write" && outcome === "ok") report.confirmedWriteSteps = (report.confirmedWriteSteps ?? 0) + 1;
    if (stage === "compaction") {
      if (outcome === "ok" && event.action === "applied") report.lastAppliedCompaction = event;
      if (isIssue(outcome)) report.lastCompactionIssue = event;
    }
    if (isIssue(outcome)) {
      report.firstFailure ??= event;
      if (stage !== "finish" || !report.lastFailure) report.lastFailure = event;
    }
    if ((outcome === "ok" || outcome === "completed") && stage !== "network" && stage !== "visibility" && stage !== "session") report.lastSuccess = event;
    if (stage === "journal_save" || stage === "result_save") report.lastSave = event;
    if (stage === "continue" && outcome === "started") {
      report.lastResume = event;
      report.manualContinuations++;
    }
    this.changed(this);
  }
  finish(outcome: DiagnosticOutcome, nextAction: DiagnosticReport["nextAction"], info?: DiagnosticDetail): void {
    this.report.outcome = outcome;
    this.report.nextAction = nextAction;
    this.event("finish", outcome, info);
  }
  resume(info?: DiagnosticDetail): void {
    this.report.outcome = "started";
    this.report.nextAction = "wait";
    this.event("continue", "started", info);
  }
  updateJournal(id: string, counts: ChangeSummary): void {
    this.journals.set(id, counts);
    const total = emptyChanges();
    for (const value of this.journals.values()) {
      total.confirmed += value.confirmed; total.pending += value.pending; total.reverted += value.reverted;
    }
    this.report.changes = total;
  }
  changedOperation(id: string, status: string): boolean {
    if (this.journalOperations.get(id) === status) return false;
    this.journalOperations.set(id, status);
    return true;
  }
}

export interface DiagnosticFile { run: DiagnosticRun; reference: string }

export function diagnoseLocal(error: unknown, fallback: DiagnosticReason = "unknown"): DiagnosticReason {
  try {
    const value = record(error);
    if (value.name === "QuotaExceededError" || value.name === "NotFoundError") return "storage";
    const message = typeof value.message === "string" ? value.message.slice(0, 240) : "";
    if (/^(?:The (?:selected )?note changed\.|Read the current note version first\.|The original selection is no longer available\.)/.test(message)) return "version_conflict";
    if (error instanceof SyntaxError || /^(?:Unsupported tool arguments|Invalid text argument|Choose a bounded set of notes)\.$/.test(message)) return "tool_arguments";
    if (message === "Read a reference returned by this task's search first.") return "note_reference_unavailable";
    if (/^(?:Use positive line numbers,|The line range is reversed\.|The requested lines are outside this reference\.|Use the next_cursor returned by the last read\.)/.test(message))
      return "read_range";
    if (/^(?:The vault changed\.?|Vault changed)$/.test(message)) return "vault_changed";
    if (/^(?:The (?:note|folder|path|attached note) is .*outside |This .* is outside |Access scope |Permission denied)/i.test(message)) return "scope";
  } catch { /* The failure remains unclassified. */ }
  return fallback;
}

function keyOf(report: DiagnosticReport): string { return PREFIX + String(report.startedAt).padStart(13, "0") + "-" + report.id + ".json"; }
function validKey(key: string): boolean { return keyPattern.test(key) && idPattern.test(keyPattern.exec(key)![2]); }
function cap(keys: string[], now: number): string[] {
  return [...new Set(keys.filter(validKey))].sort().reverse().filter((key, index) =>
    index >= MAX_REPORTS || Number(keyPattern.exec(key)![1]) < now - DIAGNOSTIC_RETENTION);
}
function encode(report: DiagnosticReport): ArrayBuffer {
  const copy = { ...report, events: [...report.events] };
  let bytes = encoder.encode(JSON.stringify(copy));
  while (bytes.length > RECORD_LIMIT && copy.events.length) {
    copy.events.shift(); copy.omitted++;
    bytes = encoder.encode(JSON.stringify(copy));
  }
  return bytes.buffer;
}

/** Per-run records keep simultaneous activities in separate encrypted device records. */
export class Diagnostics {
  private readonly live = new Map<string, DiagnosticRun>();
  private pending = new Set<DiagnosticRun>();
  private writes: Promise<void> = Promise.resolve();
  private timer: number | undefined;
  private sweepTimer: number | undefined;
  private unavailable = false;
  private disposed = false;
  constructor(private readonly storage: DiagnosticStorage, private readonly runtime: DiagnosticEnvironment,
    private readonly current: () => boolean, private readonly now: () => number = Date.now,
    private readonly signals?: () => Pick<DiagnosticDetail, "online" | "visible">,
    private readonly timers: Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval"> | undefined =
      typeof window === "undefined" ? undefined : window) {}

  maintain(): void {
    if (this.disposed || this.sweepTimer !== undefined) return;
    this.sweepTimer = this.timers?.setInterval(() => { void this.flush(); }, SWEEP_INTERVAL);
    void this.flush();
  }

  start(area: DiagnosticArea, conversation?: string, info?: DiagnosticDetail): DiagnosticRun | undefined {
    if (this.disposed || !this.current()) return;
    const now = this.now();
    const run = new DiagnosticRun({ schema: 1, id: crypto.randomUUID(), area, startedAt: now, updatedAt: now, environment: environment(this.runtime),
      outcome: "started", nextAction: "wait", events: [], omitted: 0, changes: emptyChanges(), automaticRetries: 0, manualContinuations: 0,
      conversation: matching(conversation, /^[a-zA-Z0-9_-]{1,80}$/) }, item => this.changed(item), this.now, this.signals);
    run.event("start", "started", { ...run.sampleDevice(), ...info });
    void this.flush();
    return run;
  }
  private changed(run: DiagnosticRun): void {
    if (this.disposed || !this.current()) return;
    this.live.delete(run.id);
    this.live.set(run.id, run);
    this.pending.add(run);
    for (const key of cap([...this.live.values()].map(item => keyOf(item.report)), this.now())) {
      const id = keyPattern.exec(key)![2], dropped = this.live.get(id);
      if (dropped) this.pending.delete(dropped);
      this.live.delete(id);
    }
    this.timer ??= this.timers?.setTimeout(() => { void this.flush(); }, 150);
  }
  signal(stage: "network" | "visibility" | "session", info?: DiagnosticDetail): void {
    for (const run of [...this.live.values()]) {
      if (isActive(run.report.outcome) || run.report.outcome === "paused") run.event(stage, "ok", info);
    }
  }
  flush(): Promise<void> {
    if (this.disposed) return this.writes;
    if (this.timer !== undefined) this.timers?.clearTimeout(this.timer);
    this.timer = undefined;
    const batch = [...this.pending];
    this.pending.clear();
    this.writes = this.writes.then(async () => {
      if (!this.current()) return;
      const records = new Map(batch.filter(run => this.live.has(run.id)).map(run => [keyOf(run.report), encode(run.report)]));
      const previous = await this.storage.keys(PREFIX);
      const remove = cap([...previous, ...records.keys()], this.now());
      for (const key of remove) records.delete(key);
      if (records.size) {
        await this.storage.write(records, false, { remove });
        this.unavailable = false;
      } else if (remove.length) await this.storage.discard(remove);
    }).catch(() => { this.unavailable = true; });
    return this.writes;
  }
  private async read(): Promise<DiagnosticReport[]> {
    await this.flush();
    if (!this.current() || this.disposed) return [];
    const result = new Map([...this.live.values()].reverse().map(run => [run.id, run.report]));
    try {
      const keys = (await this.storage.keys(PREFIX)).filter(validKey);
      const remove = new Set(cap(keys, this.now()));
      for (const key of keys) {
        if (remove.has(key) || result.has(keyPattern.exec(key)![2])) continue;
        try {
          const bytes = await this.storage.read(key, RECORD_LIMIT);
          const report = bytes && readReport(JSON.parse(decoder.decode(bytes)));
          if (!report || keyOf(report) !== key) { this.unavailable = true; continue; }
          if (isActive(report.outcome) || report.outcome === "paused") {
            report.outcome = "interrupted";
            report.nextAction = "check_result";
            if (report.events.length === MAX_EVENTS) report.omitted++;
            report.events = [...report.events.slice(-(MAX_EVENTS - 1)), {
              sequence: (report.events.at(-1)?.sequence ?? 0) + 1, at: this.now(), stage: "session",
              outcome: "interrupted", reason: "session_reopened",
            }];
          }
          result.set(report.id, report);
        } catch { this.unavailable = true; }
      }
    } catch { this.unavailable = true; }
    return [...result.values()].filter(report => this.current() && report.startedAt >= this.now() - DIAGNOSTIC_RETENTION)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_REPORTS);
  }
  async recentIssues(): Promise<{ reports: DiagnosticReport[]; storageUnconfirmed: boolean }> {
    const reports = (await this.read()).filter(report => isIssue(report.outcome) || !!report.firstFailure);
    return { reports, storageUnconfirmed: this.unavailable };
  }
  async copyReport(filter: { id?: string; conversation?: string; turn?: string }): Promise<string | null> {
    const reports = await this.read();
    const report = reports.find(entry => this.current() && (!filter.id || filter.id === entry.id) &&
      (!filter.conversation || filter.conversation === entry.conversation) && (!filter.turn || filter.turn === entry.turn));
    return report ? formatDiagnostics(report, this.unavailable) : null;
  }
  dispose(): Promise<void> {
    const closing = this.flush();
    this.disposed = true;
    if (this.sweepTimer !== undefined) this.timers?.clearInterval(this.sweepTimer);
    return closing;
  }
}

const human = (value: string) => value.replaceAll("_", " ");
const nextLabel: Record<DiagnosticReport["nextAction"], string> = {
  wait: "Wait for the running task or the app reply.",
  continue: "Use Continue in the same active task.",
  raise_limit: "Increase the total request limit, then use Continue in the same task.",
  review: "Review the task status and saved changes before sending again.",
  check_result: "Reopen the conversation or check the originating app for a saved result.",
  none: "No further action recorded.",
};
export function formatDiagnostics(input: DiagnosticReport, storageUnconfirmed = false): string {
  const safe = readReport(input);
  if (!safe) return "";
  const { conversation: _conversation, turn: _turn, ...report } = safe;
  const events = [...new Map([report.startEvent, report.firstFailure, report.lastFailure, report.lastSuccess, report.lastResume, report.lastSave,
    report.lastAppliedCompaction, report.lastCompactionIssue, ...report.events]
    .filter(event => !!event).map(event => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
  const failure = report.lastFailure ?? [...events].reverse().find(event => isIssue(event.outcome));
  const date = (time: number) => new Date(time).toISOString();
  const describe = (event?: DiagnosticEvent) => event ? [human(event.stage), event.action && human(event.action), human(event.outcome),
    event.reason && human(event.reason), event.reference, event.errorCode, event.httpStatus && "HTTP " + event.httpStatus,
    event.requestNumber && "request " + event.requestNumber,
    event.inputTokens !== undefined && (event.inputTokens > 0 || event.stage === "input_tokens" || event.stage === "model_request") &&
      event.inputTokens + " input tokens",
    event.visible === false && "app hidden", event.visible === true && "app visible",
    event.online === false && "device offline", event.online === true && "device reports online",
    event.appHiddenDuringRequest && "app was hidden during this request",
    isIssue(event.outcome) && event.elapsedMs !== undefined && event.elapsedMs + " ms"].filter(Boolean).join(" · ") : "None observed";
  const first = [
    "Yoofloe diagnostics",
    human(report.area) + " · " + human(report.outcome) + " · " + date(report.startedAt),
    "Last confirmed step — " + describe(report.lastSuccess),
    "Last recorded issue — " + (report.outcome === "interrupted" && !failure ? "App session ended with no final state recorded" : describe(failure)),
    ...(report.lastAppliedCompaction ? ["Last confirmed compaction — " + describe(report.lastAppliedCompaction)] : []),
    ...(report.lastCompactionIssue ? ["Last compaction issue — " + describe(report.lastCompactionIssue)] : []),
    `Recovery entries · ${report.changes.confirmed} confirmed · ${report.changes.pending} unconfirmed · ${report.changes.reverted} reverted`,
    ...(report.confirmedWriteSteps ? ["Confirmed write steps — " + report.confirmedWriteSteps] : []),
    `Recovery · ${report.automaticRetries} automatic retries · ${report.manualContinuations} manual continuations`,
    "Next action — " + nextLabel[report.nextAction],
  ];
  if (report.omitted) first.push(Math.max(0, report.omitted - (events.length - report.events.length)) + " earlier events omitted from the timeline.");
  if (storageUnconfirmed) first.push("The local diagnostics archive could not be fully verified.");
  return first.join("\n") + "\n\n" + events.map(event => `${date(event.at)}  ${event.sequence}  ${describe(event)}${event.attempt ? ` · attempt ${event.attempt}` : ""}`).join("\n") +
    "\n\n" + JSON.stringify({ ...report, storageUnconfirmed, events: events.map(event => ({ ...event, at: date(event.at) })) }, null, 2);
}
