import { AgentTask, type AgentExecutor } from "./agent-task";
import { VaultAgent, type AgentHost, type WorkJournal } from "./vault-agent";
import { safeOutbound, vaultPath, type TaskPolicy, type WorkMode, type WorkScope, type WriteScope } from "./agent-policy";
import type { AiPreferences } from "./ai-preferences";
import type { AiModelOptions, AiTransport } from "./ai-session";
import type { CalendarSession } from "./session";
import type { DeliveryV3 } from "./protocol";
import { planQuestion, QUERY_AREAS, type QueryArea, type QueryPeriod } from "./question-query";
import { buildQuestionInput } from "./question-input";
import { requestLimit, customRequestLimit, type RequestLimit } from "./request-limit";
import { CHAT_HISTORY_LIMIT, chatPreview, readChat, type ChatTurn } from "./chat-history";
import { effectiveSourceMode, readSourceMode, sourceList, type SourceMode } from "./research";
import { readGeneratedFiles, type GeneratedStore } from "./generated-files";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, readAttachments, type Attachment, type AttachmentStore } from "./attachments";

export interface WorkspaceSource { path: string; selection?: { from: number; to: number }; selectionVersion?: string }
export interface WorkspaceStorage { load(): Promise<unknown>; save(value: unknown): Promise<void>; history(): Promise<WorkJournal[]>; saveChat?(turn: ChatTurn): Promise<void>; loadChat?(id: string): Promise<ChatTurn>; searchChats?(query: string, offset: number): Promise<{ turns: ChatTurn[]; nextOffset: number | null }> }
/** One vault-owned controller. Views only subscribe; hiding one never discards paid work. */
export class AiWorkspace {
  prompt = "";
  source: WorkspaceSource | null = null;
  nextSource: WorkspaceSource | null = null;
  mode: WorkMode = "edit";
  readScope: WorkScope = "current";
  writeScope: WriteScope = "current";
  outputFolder = "";
  excluded = "";
  maximum: RequestLimit = "none";
  customMaximum: string | null = null;
  sourceMode: SourceMode = "expanded";
  onlineMaximum: RequestLimit = "none";
  customOnlineMaximum: string | null = null;
  attachments: Attachment[] = [];
  addingAttachments = false;
  model: AiModelOptions = { model: "" };
  configured = false;
  busy = false;
  ready = false;
  message = "";
  preview = "";
  task: AgentTask | null = null;
  agent: VaultAgent | null = null;
  history: WorkJournal[] = [];
  previous: { request: string; answer: string; sourceMode?: SourceMode }[] = [];
  chat: ChatTurn[] = [];
  private activeChatId: string | null = null;
  calendarQuestion = "";
  area: QueryArea | "auto" = "auto";
  period: QueryPeriod | "auto" = "auto";
  delivery: DeliveryV3 | null = null;
  private calendar: CalendarSession | null = null;
  private alive = true;
  private listeners = new Set<() => void>();
  private saveQueue: Promise<void> = Promise.resolve();
  private lastRequest = "";
  private initialization: Promise<void> | null = null;
  private runEpoch = 0;
  private running = false;
  private stopRequested = false;
  constructor(private readonly options: {
    current(): boolean; preferences: AiPreferences; host(current: () => boolean): AgentHost; transport: AiTransport; generated?: GeneratedStore; attachments?: AttachmentStore;
    gate: { busy: boolean }; configDir: string; storage: WorkspaceStorage; calendar?: () => CalendarSession; inboxHint(): string;
  }) {}
  get current() { return this.alive && this.options.current(); }
  get requestId() { return this.calendar?.requestId ?? null; }
  get title() { return this.source?.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? (this.writeScope === "new" ? "New documents" : "No note attached"); }
  get result() { return this.task?.text ?? ""; }
  get hasResult() { return !!this.result || (this.task?.generated.length ?? 0) > 0; }
  get canStop() { return this.busy && this.running && !this.stopRequested; }
  get stopping() { return this.busy && this.stopRequested; }
  get canContinue() { return this.current && !!this.task?.canResume && !!this.agent; }
  get settingsLocked() { return this.busy || this.canContinue || this.addingAttachments; }
  get limitProblem(): string {
    if (this.customOnlineMaximum !== null && customRequestLimit(this.customOnlineMaximum) === null) return "Enter a positive tool count, or choose no tool-count limit.";
    try { requestLimit(this.onlineMaximum); } catch { return "Choose a valid built-in tool limit."; }
    if (this.customMaximum !== null && customRequestLimit(this.customMaximum) === null) return "Enter a positive whole number, or choose no request-count limit.";
    try { requestLimit(this.maximum); return ""; } catch { return "Choose a positive whole number or no request-count limit."; }
  }
  get canResumeWithLimit() { return this.canContinue && !this.limitProblem && (this.maximum === "none" || this.maximum > (this.task?.requests ?? 0)); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  changed(): void { if (this.current) for (const listener of this.listeners) listener(); }
  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.load();
    await this.initialization;
  }
  private async load(): Promise<void> {
    if (this.ready) return;
    try {
      const raw = await this.options.storage.load(); if (!this.current) return;
      if (raw && typeof raw === "object") {
        const saved = raw as Record<string, unknown>;
        if (typeof saved.prompt === "string" && saved.prompt.length <= 32000) this.prompt = saved.prompt;
        if (typeof saved.lastRequest === "string") this.lastRequest = saved.lastRequest.slice(0, 32000);
        if (typeof saved.source === "string" && this.options.host(() => this.current).files().some(file => file.path === saved.source)) this.source = { path: saved.source };
        if (this.source && saved.selection && typeof saved.selection === "object") {
          const selection = saved.selection as Record<string, unknown>;
          if (typeof selection.from === "number" && typeof selection.to === "number" && Number.isSafeInteger(selection.from) && Number.isSafeInteger(selection.to) && selection.from >= 0 && selection.to >= selection.from && typeof saved.selectionVersion === "string" && /^[a-f0-9]{64}$/.test(saved.selectionVersion)) {
            this.source.selection = { from: selection.from, to: selection.to }; this.source.selectionVersion = saved.selectionVersion;
          }
        }
        if (typeof saved.mode === "string" && ["ask", "edit", "organize", "all"].includes(saved.mode)) this.mode = saved.mode as WorkMode;
        this.sourceMode = readSourceMode(saved.sourceMode);
        this.attachments = readAttachments(saved.attachments);
        try { if (saved.onlineMaximum !== undefined) this.onlineMaximum = requestLimit(saved.onlineMaximum); } catch { this.onlineMaximum = 1; }
        if (typeof saved.customOnlineMaximum === "string") { this.customOnlineMaximum = saved.customOnlineMaximum.slice(0, 32); const count = customRequestLimit(this.customOnlineMaximum); if (count !== null) this.onlineMaximum = count; }
        if (typeof saved.readScope === "string" && ["current", "folder", "vault"].includes(saved.readScope)) this.readScope = saved.readScope as WorkScope;
        if (typeof saved.writeScope === "string" && ["current", "new", "folder", "vault"].includes(saved.writeScope)) this.writeScope = saved.writeScope as WriteScope;
        if (typeof saved.outputFolder === "string") this.outputFolder = saved.outputFolder.slice(0, 500);
        if (typeof saved.excluded === "string") this.excluded = saved.excluded.slice(0, 4000);
        try { if (saved.maximum !== undefined) this.maximum = requestLimit(saved.maximum); } catch { this.maximum = 1; this.message = "The saved request limit was invalid and was reset to 1. Choose your preferred limit before sending."; }
        if (typeof saved.customMaximum === "string") { this.customMaximum = saved.customMaximum.slice(0, 32); const count = customRequestLimit(this.customMaximum); if (count !== null) this.maximum = count; }
        if (Array.isArray(saved.previous)) this.previous = saved.previous.filter((v): v is { request: string; answer: string; sourceMode?: SourceMode } => !!v && typeof v === "object" && typeof (v as Record<string, unknown>).request === "string" && typeof (v as Record<string, unknown>).answer === "string").slice(-2).map(v => ({ request: v.request.slice(0, 8000), answer: v.answer.slice(0, 12000), sourceMode: v.sourceMode === "expanded" ? "expanded" : "provided" }));
        if (typeof saved.result === "string" && saved.result.length <= 4 * 1024 * 1024) { this.task = this.createTask({ execute: () => Promise.reject(Error("Start a new task first.")) }); this.task.text = saved.result; }
        if (saved.taskUsage && typeof saved.taskUsage === "object") {
          const summary = saved.taskUsage as Record<string, unknown>;
          if (typeof summary.requests === "number" && Number.isSafeInteger(summary.requests) && summary.requests > 0) {
            if (!this.task) this.task = this.createTask({ execute: () => Promise.reject(Error("Start a new task first.")) });
            this.task.restoreSummary({ requests: summary.requests, model: summary.model, usage: summary.usage });
            this.task.sourceMode = summary.sourceMode === "expanded" ? "expanded" : "provided";
            this.task.sources = sourceList(summary.sources); this.task.citedSources = sourceList(summary.citedSources); this.task.generated = readGeneratedFiles(summary.generated);
            if (typeof summary.transcriptions === "number" && Number.isSafeInteger(summary.transcriptions) && summary.transcriptions >= 0) this.task.transcriptions = summary.transcriptions;
            if (summary.online && typeof summary.online === "object") for (const key of ["search", "analysis", "image"] as const) { const value = (summary.online as Record<string, unknown>)[key]; if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) this.task.online[key] = value; }
            this.task.events.push({ kind: "status", text: `Saved task · ${summary.requests} request(s). No request resumed automatically.` });
            if (summary.state === "paused" || summary.state === "running") this.message = "The previous task ended when the vault session closed. Saved answers and completed changes are kept. Start a focused follow-up; no request resumed automatically.";
          }
        }
        if (Array.isArray(saved.chat)) this.chat = saved.chat.map(readChat).filter((turn): turn is ChatTurn => !!turn).slice(-CHAT_HISTORY_LIMIT).map(turn => ({ ...turn, status: turn.status === "running" || turn.status === "paused" ? "stopped" : turn.status }));
        if (!this.chat.length) {
          const restored = [...this.previous];
          if (this.result && !restored.some(turn => turn.request === this.lastRequest && turn.answer === this.result)) restored.push({ request: this.lastRequest, answer: this.result });
          for (const turn of restored) {
            const usage = saved.taskUsage && typeof saved.taskUsage === "object" ? saved.taskUsage as Record<string, unknown> : {};
            const latest = turn.answer === this.result && turn.request === this.lastRequest;
            const record: ChatTurn = { id: crypto.randomUUID(), request: turn.request, answer: turn.answer, startedAt: null, sourcePath: latest ? this.source?.path ?? "" : "", model: latest ? this.task?.modelId ?? "" : "", status: latest && (usage.state === "paused" || usage.state === "running") ? "stopped" : "completed", requests: latest ? this.task?.requests ?? 0 : 0, inputTokens: latest ? this.task?.usage.input ?? 0 : 0, outputTokens: latest ? this.task?.usage.output ?? 0 : 0, actions: [] };
            this.chat.push(record); await this.options.storage.saveChat?.(record);
          }
        }
      }
      this.history = await this.options.storage.history();
      await this.refreshSettings();
    } catch { this.message = "Saved work could not be read. Existing files and keys were kept."; }
    finally { this.ready = true; this.changed(); }
  }
  async refreshSettings(): Promise<void> {
    try { const [model, configured] = await Promise.all([this.options.preferences.read("openai"), this.options.preferences.hasKey("openai")]); if (!this.current) return; this.model = model; this.configured = configured; }
    catch { this.message = "Open settings to save your key locally and choose a model."; }
    this.changed();
  }
  bind(source: WorkspaceSource | null, force = false): void {
    if (!this.current) return;
    if ((this.busy || this.canContinue || this.hasResult || this.prompt.trim()) && !force) { if (source?.path !== this.source?.path) this.nextSource = source; this.changed(); return; }
    const sourceChanged = source?.path !== this.source?.path;
    this.source = source; this.nextSource = null;
    if (sourceChanged) this.outputFolder = source?.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
    this.preview = ""; this.changed();
  }
  setPrompt(value: string): void { if (!this.settingsLocked) { this.prompt = value; this.preview = ""; } }
  async setModel(model: AiModelOptions): Promise<void> { if (this.settingsLocked) return; try { await this.options.preferences.save(model, "openai"); this.model = model; } catch { this.message = "Model settings could not be saved. No request was sent."; } this.changed(); }
  private policy(): TaskPolicy {
    const folder = this.outputFolder.trim().replace(/\/$/, ""), excluded = this.excluded.split("\n").map(s => s.trim()).filter(Boolean);
    if (folder) vaultPath(folder, true); for (const path of excluded) vaultPath(path, true);
    return { sourcePath: this.source?.path ?? null, folder: this.outputFolder.trim().replace(/\/$/, ""), readScope: this.readScope, writeScope: this.writeScope, mode: this.mode,
      configDir: this.options.configDir, excluded, ...(this.source?.selection && this.readScope === "current" ? { selection: { ...this.source.selection }, selectionVersion: this.source.selectionVersion } : {}) };
  }
  private createTask(executor: AgentExecutor, current = () => this.current, writeScope = this.writeScope): AgentTask {
    return new AgentTask({ current, preserve: () => this.current, key: () => this.options.preferences.key("openai"), transport: this.options.transport, executor, gate: this.options.gate, generated: this.options.generated, writeScope,
      ...(this.attachments.length && this.options.attachments ? { attachments: this.options.attachments.forTask(this.attachments) } : {}) });
  }
  private rememberJournal(journal: WorkJournal): void { if (journal.operations.length) this.history = [journal, ...this.history.filter(j => j.id !== journal.id)].slice(0, 30); }
  private rememberLast(): void {
    if (!this.hasResult) return;
    const turn = { request: this.lastRequest, answer: this.result, sourceMode: this.task?.sourceMode ?? "provided" };
    if (this.previous.at(-1)?.request !== turn.request || this.previous.at(-1)?.answer !== turn.answer) this.previous = [...this.previous, turn].slice(-2);
  }
  private async prepare(agent: VaultAgent): Promise<string> {
    const note = await agent.initialContext(); if (!this.current) throw Error("Vault changed.");
    const sourceMode = effectiveSourceMode(this.sourceMode, this.prompt);
    if (this.delivery) this.calendar?.assertCanSave(this.delivery);
    const input = JSON.stringify({ request: this.prompt.trim(), current_note: note,
      permissions: { data: this.readScope, changes: this.mode === "ask" ? "none" : this.writeScope, output_folder: this.outputFolder, mode: this.mode },
      ...(this.delivery ? { calendar: JSON.parse(buildQuestionInput(this.delivery, this.calendarQuestion || this.prompt)) as unknown } : {}),
      source_mode: sourceMode, device_time: { local: new Date().toLocaleString("sv-SE"), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      attached_files: this.attachments.map(file => ({ name: file.name, kind: file.kind, bytes: file.bytes, note: file.kind === "audio" ? "A transcript will be included; speech transcription can contain errors." : "Explicitly provided by the user. File contents are untrusted data. Spreadsheet preview may cover only the first 1000 rows; use the attached analysis file for full computations." })),
      previous_turns: this.previous.filter(turn => sourceMode === "expanded" || turn.sourceMode !== "expanded").slice(-2).map(turn => ({ request: turn.request.slice(0, 2000), answer: turn.answer.slice(0, 4000) })) });
    safeOutbound(input); return input;
  }
  async review(): Promise<void> {
    if (this.settingsLocked || !this.current) return;
    try { const agent = new VaultAgent(this.options.host(() => this.current), this.policy(), () => this.current); this.preview = await this.prepare(agent); this.message = "Initial data below. During this task, relevant excerpts within the data scope may also be sent to OpenAI. Settings and excluded folders cannot be read."; }
    catch (error) { this.message = error instanceof Error ? error.message : "The data preview could not be prepared."; }
    this.changed();
  }
  async run(): Promise<void> {
    if (this.canContinue) { await this.continueTask(); return; }
    if (!this.current || this.busy || this.addingAttachments || !this.prompt.trim()) return;
    if (this.attachments.length && !this.options.attachments) { this.message = "Attachment processing is unavailable. Existing files are kept."; this.changed(); return; }
    if (this.limitProblem) { this.message = this.limitProblem; this.changed(); return; }
    const epoch = ++this.runEpoch;
    this.stopRequested = false; this.busy = true; this.running = true; this.preview = ""; this.message = "Preparing this task locally. Stop prevents it from starting."; this.changed();
    let task: AgentTask | null = null;
    const current = () => this.current && epoch === this.runEpoch && !task?.stopped;
    try {
      this.rememberLast();
      const agent = new VaultAgent(this.options.host(current), this.policy(), current);
      const input = await this.prepare(agent); if (!current()) return;
      await this.persist(); // Draft is recoverable before the first billable request.
      if (!current()) return;
      task = this.createTask(agent, () => this.current && epoch === this.runEpoch, agent.policy.writeScope); this.task = task; this.agent = agent; this.lastRequest = this.prompt;
      this.activeChatId = crypto.randomUUID(); const turn: ChatTurn = { id: this.activeChatId, request: this.prompt.trim(), answer: "", startedAt: Date.now(), model: this.model.model, status: "running", requests: 0, inputTokens: 0, outputTokens: 0, actions: [], attachments: [...this.attachments], sourceMode: this.sourceMode }; this.chat = [...this.chat, turn].slice(-CHAT_HISTORY_LIMIT);
      const unsubscribe = this.watchTask(task);
      try { await task.run(input, { ...this.model }, this.mode, this.maximum, { mode: this.sourceMode, maximum: this.onlineMaximum }); }
      finally { unsubscribe(); }
      if (!this.current) return;
      await this.collectTask(task, agent);
    } catch (error) { this.message = epoch !== this.runEpoch ? "Stopped. No further request or file action was started." : error instanceof Error ? error.message : "The task could not finish. No automatic retry was made."; }
    finally {
      this.running = false;
      if (this.stopRequested) this.message = "Stopped. Completed work and any returned answer are kept; no further request or file action was started.";
      if (this.current) { this.changed(); await this.persist().catch(() => { this.message += " Local draft saving could not be confirmed."; }); }
      this.busy = false; if (this.current) this.changed();
    }
  }
  private watchTask(task: AgentTask): () => void {
    return task.subscribe(() => {
      if (this.agent) this.captureChat(task, this.agent);
      if (task.events.at(-1)?.kind === "response") void this.persist().catch(() => { this.message = "Local answer saving could not be confirmed. Keep this vault session open."; this.changed(); });
      this.changed();
    });
  }
  private async collectTask(task: AgentTask, agent: VaultAgent): Promise<void> {
    this.message = task.message;
    if (this.source && agent.policy.sourcePath) this.source.path = agent.policy.sourcePath;
    if (this.source && agent.policy.selection) { this.source.selection = { ...agent.policy.selection }; this.source.selectionVersion = agent.policy.selectionVersion; }
    if (task.state !== "paused" && !task.fileWarnings.length && (task.text || agent.operations.some(op => op.status === "done") || task.state === "completed" && task.generated.length > 0)) { this.prompt = ""; this.attachments = []; }
    for (const journal of agent.journals) if (journal.operations.length) {
      journal.status = task.state !== "completed" || task.events.some(e => e.kind === "blocked") ? "interrupted" : "complete";
      await this.options.host(() => this.current).persist(journal); this.rememberJournal(journal);
    }
    this.captureChat(task, agent);
    const turn = this.chat.find(item => item.id === this.activeChatId); if (turn) await this.archiveChat(turn);
  }
  private captureChat(task: AgentTask, agent: VaultAgent): void {
    const turn = this.chat.find(item => item.id === this.activeChatId); if (!turn) return;
    turn.answer = task.text; turn.status = task.state === "idle" ? "running" : task.state;
    turn.actionsKnown = true; turn.sourcePath = agent.policy.sourcePath ?? "";
    turn.requests = task.requests; turn.inputTokens = task.usage.input; turn.outputTokens = task.usage.output;
    turn.sourceMode = task.sourceMode; turn.sources = task.citedSources.length ? task.citedSources : task.sources; turn.online = { ...task.online }; turn.generated = task.generated;
    turn.transcriptions = task.transcriptions; turn.fileWarnings = [...task.fileWarnings];
    const actions = agent.operations.filter(op => op.status === "done"); turn.actionTotal = actions.length;
    const manualAssets = turn.actions.filter(op => op.kind === "asset" && !actions.some(action => action.kind === "asset" && action.path === op.path));
    turn.actions = [...manualAssets, ...actions.map(op => ({ kind: op.kind, path: op.path, ...(op.target ? { target: op.target } : {}) }))].slice(-100); turn.actionTotal += manualAssets.length;
    if (task.events.at(-1)?.kind === "response") void this.archiveChat(turn);
  }
  private async archiveChat(turn: ChatTurn): Promise<void> {
    try { await this.options.storage.saveChat?.(turn); }
    catch { this.message = "Full chat saving could not be confirmed. The current answer is kept; copy it before starting another task."; }
  }
  async loadFullChat(id: string): Promise<void> {
    if (!this.current || !this.options.storage.loadChat) return;
    try { const full = await this.options.storage.loadChat(id); if (!this.current) return; if (id !== this.activeChatId && (full.status === "running" || full.status === "paused")) full.status = "stopped"; const index = this.chat.findIndex(turn => turn.id === id); if (index >= 0) this.chat[index] = full; }
    catch { this.message = "The full local chat record is unavailable. Its saved preview is kept."; }
    this.changed();
  }
  async continueTask(): Promise<void> {
    if (this.busy || !this.canContinue || !this.task || !this.agent) return;
    if (!this.canResumeWithLimit) { this.message = this.limitProblem || "Choose a total limit above requests already used, or no request-count limit."; this.changed(); return; }
    const task = this.task, agent = this.agent;
    this.busy = true; this.running = true; this.stopRequested = false; this.message = "Continuing the original task with its original model and scopes."; this.changed();
    const unsubscribe = this.watchTask(task);
    try { await this.persist(); if (this.stopRequested || !this.current) return; await task.resume(this.maximum, this.onlineMaximum); if (this.current) await this.collectTask(task, agent); }
    catch (error) { this.message = error instanceof Error ? error.message : "This task could not continue. No retry was made."; }
    finally { unsubscribe(); this.running = false; if (this.stopRequested) this.message = "Stopped. Completed work and returned answers are kept."; if (this.current) { this.changed(); await this.persist().catch(() => {}); } this.busy = false; if (this.current) this.changed(); }
  }
  async finishHere(): Promise<void> {
    if (this.busy || !this.canContinue) return; this.task?.finish(); this.message = this.task?.message ?? "Finished here.";
    if (this.task && this.agent) this.captureChat(this.task, this.agent);
    const turn = this.chat.find(item => item.id === this.activeChatId); if (turn) { turn.status = "stopped"; await this.archiveChat(turn); }
    await this.persist(); this.changed();
  }
  stop(): void { if (!this.canStop) return; this.stopRequested = true; this.runEpoch++; this.task?.stop(); this.message = "Stopping. Completed work is kept. An already-sent request may still finish and incur charges; no further request or file action will start."; this.changed(); }
  async newTask(source: WorkspaceSource | null = this.nextSource ?? this.source): Promise<void> {
    if (this.addingAttachments) return;
    if (this.busy) return;
    if (this.canContinue) await this.finishHere();
    this.rememberLast();
    this.prompt = ""; this.task = null; this.agent = null; this.activeChatId = null; this.attachments = []; this.message = "Ready. No data is sent until you start."; this.bind(source, true); await this.persist(); this.changed();
  }
  async addAttachments(files: readonly File[]): Promise<void> {
    if (this.settingsLocked || !this.current || !files.length) return;
    if (!this.options.attachments) { this.message = "Attachment storage is unavailable."; this.changed(); return; }
    this.addingAttachments = true; this.message = "Adding attachments on this device…"; this.changed();
    try {
      for (const file of files) {
        if (this.attachments.length >= MAX_ATTACHMENTS || this.attachments.reduce((sum,a) => sum+a.bytes,0)+file.size > MAX_ATTACHMENT_BYTES) throw Error("Attach up to 10 files with a combined size of 20 MiB. Earlier selections are kept.");
        const item = await this.options.attachments.add(file, () => this.current); if (!this.current) return;
        if (!this.attachments.some(existing => existing.sha256 === item.sha256 && existing.name === item.name)) this.attachments.push(item);
      }
      this.message = "Attachments are ready on this device. Send shares them with OpenAI; audio transcription has an additional charge."; await this.persist();
    } catch (error) { this.message = error instanceof Error ? error.message : "An attachment could not be added."; }
    finally { if (this.current) await this.persist().catch(() => { this.message += " The attachment selection could not be saved locally."; }); this.addingAttachments = false; this.changed(); }
  }
  useAttachments(files: readonly Attachment[]): void {
    if (this.settingsLocked || !this.current) return;
    const merged = [...new Map([...this.attachments, ...readAttachments(files)].map(file => [file.id, file])).values()];
    if (merged.length > MAX_ATTACHMENTS || merged.reduce((sum, file) => sum + file.bytes, 0) > MAX_ATTACHMENT_BYTES) { this.message = "Remove some selected files before attaching these again."; this.changed(); return; }
    this.attachments = merged; this.message = "Attachments selected for your next request. They are sent only when you choose Send."; this.changed(); void this.persist().catch(() => { this.message = "The attachment selection could not be saved."; this.changed(); });
  }
  removeAttachment(id: string): void { if (this.settingsLocked) return; this.attachments = this.attachments.filter(file => file.id !== id); this.preview = ""; this.changed(); void this.persist().catch(() => { this.message = "The attachment selection could not be saved."; this.changed(); }); }
  async searchChats(query: string, offset = 0) { return this.options.storage.searchChats ? this.options.storage.searchChats(query, offset) : { turns: this.chat.filter(turn => (turn.request+"\n"+turn.answer).toLocaleLowerCase().includes(query.toLocaleLowerCase())), nextOffset: null }; }
  async fullChat(id: string): Promise<ChatTurn | null> { if (!this.current || !this.options.storage.loadChat) return null; const turn = await this.options.storage.loadChat(id); return this.current ? turn : null; }
  setSourceMode(mode: SourceMode): void { if (this.settingsLocked) return; this.sourceMode = readSourceMode(mode); this.preview = ""; this.changed(); }
  async saveGeneratedFile(turnId: string, fileId: string): Promise<ChatTurn | null> {
    if (this.settingsLocked || !this.current) return null;
    this.busy = true; this.changed();
    try {
      const turn = this.options.storage.loadChat ? await this.options.storage.loadChat(turnId) : this.chat.find(item => item.id === turnId);
      if (!this.current || !turn || turn.id !== turnId || turn.requestTruncated || turn.answerTruncated || turn.generatedTruncated) throw Error("The full saved conversation could not be verified. Its original text is kept.");
      const file = turn.generated?.find(item => item.id === fileId); if (!file) throw Error("This generated file is not available in the saved conversation.");
      // This button authorizes one explicit attachment save, never a broader AI task.
      const original = this.policy(), policy: TaskPolicy = { ...original, mode: "edit", writeScope: "new" };
      const agent = new VaultAgent(this.options.host(() => this.current), policy, () => this.current); agent.research([], [file]);
      const path = `${this.outputFolder ? this.outputFolder.replace(/\/$/, "") + "/" : ""}Yoofloe assets/${file.id}.${file.extension}`;
      await agent.execute("save_generated_file", { reference: file.id, path }); await agent.finish();
      for (const journal of agent.journals) this.rememberJournal(journal);
      turn.actions.push({ kind: "asset", path }); turn.actionTotal = (turn.actionTotal ?? turn.actions.length - 1) + 1; turn.actionsKnown = true;
      if (this.options.storage.saveChat) await this.options.storage.saveChat(turn);
      const index = this.chat.findIndex(item => item.id === turn.id); if (index >= 0) this.chat[index] = turn;
      this.message = `Saved attachment: ${path}. No AI request was made.`; await this.persist(); return turn;
    } catch (error) { this.message = error instanceof Error ? error.message : "The attachment could not be saved."; return null; }
    finally { this.busy = false; this.changed(); }
  }
  async undo(journal: WorkJournal): Promise<void> {
    if (!this.current || this.settingsLocked) return; this.busy = true; this.changed();
    try { const agent = new VaultAgent(this.options.host(() => this.current), this.policy(), () => this.current); const result = await agent.undo(journal); if (this.source && agent.policy.sourcePath) this.source.path = agent.policy.sourcePath; this.message = `Undo: ${result.restored} action(s) restored; ${result.kept} kept because recovery could not safely be confirmed. Newer user edits are preserved.`; await this.persist(); }
    catch { this.message = "Recovery could not be confirmed. Notes and backups were kept."; }
    finally { this.busy = false; this.changed(); }
  }
  async confirmTrash(): Promise<void> {
    if (!this.agent || this.settingsLocked || !this.current) return; this.busy = true; this.changed();
    let failed = false;
    try { await this.agent.confirmTrash(); this.message = "Selected notes moved to Obsidian Trash. Original backups and Undo are available."; }
    catch (error) { failed = true; this.message = error instanceof Error ? error.message : "Trash could not be confirmed. No retry was made."; }
    finally {
      if (this.current) {
        for (const journal of this.agent.journals) if (journal.operations.length) {
          journal.status = failed ? "interrupted" : "complete"; this.rememberJournal(journal);
          await this.options.host(() => this.current).persist(journal).catch(() => { this.message += " The recovery record could not be refreshed; original backups are kept."; });
        }
        if (this.task) this.captureChat(this.task, this.agent);
        const turn = this.chat.find(item => item.id === this.activeChatId); if (turn) await this.archiveChat(turn);
        await this.persist();
      }
      this.busy = false; this.changed();
    }
  }
  async findCalendar(): Promise<string | null> {
    if (!this.current || this.settingsLocked || !this.options.calendar || this.requestId) return null;
    this.busy = true; this.changed();
    try {
      const question = this.calendarQuestion.trim() || this.prompt.trim(); if (!question) throw Error("Describe the Calendar information needed for this task."); this.calendarQuestion = question;
      const overrides = { ...(this.area !== "auto" ? { areas: [this.area] } : {}), ...(this.period !== "auto" ? { period: this.period } : {}) };
      const query = planQuestion(question, overrides).query ?? planQuestion(question, { ...overrides, areas: QUERY_AREAS }).query;
      if (!query) throw Error("Describe a specific topic or date to search.");
      this.calendar = this.options.calendar(); const vaultId = await this.options.preferences.vaultId(); if (!this.current) return null;
      return await this.calendar.start({ vaultId, query, inboxHint: this.options.inboxHint() });
    } catch (error) { this.message = error instanceof Error ? error.message : "Calendar could not be opened."; return null; }
    finally { this.busy = false; this.changed(); }
  }
  async receiveCalendar(id: string): Promise<void> {
    if (!this.current || this.settingsLocked || !this.calendar || this.delivery) return;
    this.busy = true;
    try { const reply = await this.calendar.receive(id); if (!this.current || reply.version !== 3) return; this.delivery = reply; this.message = `${reply.records.length} Calendar excerpt(s) added. Local lookup made no AI request. Review before sending to OpenAI.`; }
    catch { this.message = "No verified Calendar reply yet. Approve the local search in Calendar, then check again."; }
    finally { this.busy = false; this.changed(); }
  }
  async removeCalendar(): Promise<void> { if (this.settingsLocked) return; await this.calendar?.dispose(); this.calendar = null; this.delivery = null; this.preview = ""; this.changed(); }
  persist(): Promise<void> {
    const value = { prompt: this.prompt, lastRequest: this.lastRequest, source: this.source?.path ?? null, selection: this.source?.selection, selectionVersion: this.source?.selectionVersion, mode: this.mode, readScope: this.readScope, writeScope: this.writeScope,
      outputFolder: this.outputFolder, excluded: this.excluded, maximum: this.maximum, result: this.result, previous: this.previous, sourceMode: this.sourceMode, onlineMaximum: this.onlineMaximum, attachments: this.attachments,
      ...(this.customOnlineMaximum !== null ? { customOnlineMaximum: this.customOnlineMaximum } : {}),
      ...(this.customMaximum !== null ? { customMaximum: this.customMaximum } : {}),
      ...(this.chat.length ? { chat: this.chat.slice(-CHAT_HISTORY_LIMIT).map(chatPreview) } : {}),
      ...(this.task && this.task.requests > 0 ? { taskUsage: { requests: this.task.requests, state: this.task.state, model: this.task.modelId, usage: { ...this.task.usage }, sourceMode: this.task.sourceMode, sources: this.task.sources, citedSources: this.task.citedSources, generated: this.task.generated, online: this.task.online, transcriptions: this.task.transcriptions } } : {}) };
    const next = this.saveQueue.then(async () => { if (!this.current) return; await this.options.storage.save(value); }); this.saveQueue = next.catch(() => {}); return next;
  }
  dispose(): void { this.task?.stop(); this.alive = false; this.listeners.clear(); void this.calendar?.dispose(); }
}
