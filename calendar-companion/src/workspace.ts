import { AgentTask } from "./agent-task";
import { VaultAgent, type AgentHost, type WorkJournal } from "./vault-agent";
import { safeOutbound, vaultPath, type TaskPolicy, type WorkMode, type WorkScope } from "./agent-policy";
import type { AiPreferences } from "./ai-preferences";
import type { AiModelOptions, AiTransport } from "./ai-session";
import type { CalendarSession } from "./session";
import type { DeliveryV3 } from "./protocol";
import { planQuestion, QUERY_AREAS, type QueryArea, type QueryPeriod } from "./question-query";
import { buildQuestionInput } from "./question-input";

export interface WorkspaceSource { path: string; selection?: { from: number; to: number }; selectionVersion?: string }
export interface WorkspaceStorage { load(): Promise<unknown>; save(value: unknown): Promise<void>; history(): Promise<WorkJournal[]> }
/** One vault-owned controller. Views only subscribe; hiding one never discards paid work. */
export class AiWorkspace {
  prompt = "";
  source: WorkspaceSource | null = null;
  nextSource: WorkspaceSource | null = null;
  mode: WorkMode = "edit";
  readScope: WorkScope = "current";
  writeScope: WorkScope = "current";
  outputFolder = "";
  excluded = "";
  maximum = 4;
  model: AiModelOptions = { model: "" };
  configured = false;
  busy = false;
  ready = false;
  message = "";
  preview = "";
  task: AgentTask | null = null;
  agent: VaultAgent | null = null;
  history: WorkJournal[] = [];
  previous: { request: string; answer: string }[] = [];
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
  constructor(private readonly options: {
    current(): boolean; preferences: AiPreferences; host(current: () => boolean): AgentHost; transport: AiTransport;
    gate: { busy: boolean }; configDir: string; storage: WorkspaceStorage; calendar?: () => CalendarSession; inboxHint(): string;
  }) {}
  get current() { return this.alive && this.options.current(); }
  get requestId() { return this.calendar?.requestId ?? null; }
  get title() { return this.source?.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "New document"; }
  get result() { return this.task?.text ?? ""; }
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
          if (typeof selection.from === "number" && typeof selection.to === "number" && Number.isSafeInteger(selection.from) && Number.isSafeInteger(selection.to) && selection.from >= 0 && selection.to > selection.from && typeof saved.selectionVersion === "string" && /^[a-f0-9]{64}$/.test(saved.selectionVersion)) {
            this.source.selection = { from: selection.from, to: selection.to }; this.source.selectionVersion = saved.selectionVersion;
          }
        }
        if (["ask", "edit", "organize"].includes(String(saved.mode))) this.mode = saved.mode as WorkMode;
        for (const key of ["readScope", "writeScope"] as const) if (["current", "folder", "vault"].includes(String(saved[key]))) this[key] = saved[key] as WorkScope;
        if (typeof saved.outputFolder === "string") this.outputFolder = saved.outputFolder.slice(0, 500);
        if (typeof saved.excluded === "string") this.excluded = saved.excluded.slice(0, 4000);
        if (typeof saved.maximum === "number" && saved.maximum >= 1 && saved.maximum <= 10 && Number.isInteger(saved.maximum)) this.maximum = saved.maximum;
        if (Array.isArray(saved.previous)) this.previous = saved.previous.filter((v): v is { request: string; answer: string } => !!v && typeof v === "object" && typeof (v as Record<string, unknown>).request === "string" && typeof (v as Record<string, unknown>).answer === "string").slice(-2).map(v => ({ request: v.request.slice(0, 8000), answer: v.answer.slice(0, 12000) }));
        if (typeof saved.result === "string" && saved.result.length <= 4 * 1024 * 1024) { this.task = this.createTask({ execute: () => Promise.reject(Error("Start a new task first.")) }); this.task.text = saved.result; }
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
    if ((this.busy || this.result || this.prompt.trim()) && !force) { if (source?.path !== this.source?.path) this.nextSource = source; this.changed(); return; }
    this.source = source; this.nextSource = null; this.outputFolder = source?.path.includes("/") ? source.path.slice(0, source.path.lastIndexOf("/")) : "";
    this.preview = ""; this.changed();
  }
  setPrompt(value: string): void { if (!this.busy) { this.prompt = value; this.preview = ""; } }
  async setModel(model: AiModelOptions): Promise<void> { if (this.busy) return; try { await this.options.preferences.save(model, "openai"); this.model = model; } catch { this.message = "Model settings could not be saved. No request was sent."; } this.changed(); }
  private policy(): TaskPolicy {
    const folder = this.outputFolder.trim().replace(/\/$/, ""), excluded = this.excluded.split("\n").map(s => s.trim()).filter(Boolean);
    if (folder) vaultPath(folder, true); for (const path of excluded) vaultPath(path, true);
    return { sourcePath: this.source?.path ?? null, folder: this.outputFolder.trim().replace(/\/$/, ""), readScope: this.readScope, writeScope: this.writeScope, mode: this.mode,
      configDir: this.options.configDir, excluded, ...(this.source?.selection && this.readScope === "current" ? { selection: { ...this.source.selection }, selectionVersion: this.source.selectionVersion } : {}) };
  }
  private createTask(executor: { execute(name: string, args: unknown): Promise<unknown> }): AgentTask {
    return new AgentTask({ current: () => this.current, key: () => this.options.preferences.key("openai"), transport: this.options.transport, executor, gate: this.options.gate });
  }
  private rememberLast(): void {
    if (!this.result) return;
    const turn = { request: this.lastRequest, answer: this.result };
    if (this.previous.at(-1)?.request !== turn.request || this.previous.at(-1)?.answer !== turn.answer) this.previous = [...this.previous, turn].slice(-2);
  }
  private async prepare(agent: VaultAgent): Promise<string> {
    const note = await agent.initialContext(); if (!this.current) throw Error("Vault changed.");
    if (this.delivery) this.calendar?.assertCanSave(this.delivery);
    const input = JSON.stringify({ request: this.prompt.trim(), current_note: note,
      permissions: { data: this.readScope, changes: this.mode === "ask" ? "none" : this.writeScope, output_folder: this.outputFolder, mode: this.mode },
      ...(this.delivery ? { calendar: JSON.parse(buildQuestionInput(this.delivery, this.calendarQuestion || this.prompt)) as unknown } : {}),
      previous_turns: this.previous.slice(-2).map(turn => ({ request: turn.request.slice(0, 2000), answer: turn.answer.slice(0, 4000) })) });
    safeOutbound(input); return input;
  }
  async review(): Promise<void> {
    if (this.busy || !this.current) return;
    try { const agent = new VaultAgent(this.options.host(() => this.current), this.policy(), () => this.current); this.preview = await this.prepare(agent); this.message = "Initial data below. During this task, relevant excerpts within the data scope may also be sent to OpenAI. Settings and excluded folders cannot be read."; }
    catch (error) { this.message = error instanceof Error ? error.message : "The data preview could not be prepared."; }
    this.changed();
  }
  async run(): Promise<void> {
    if (!this.current || this.busy || !this.prompt.trim()) return;
    this.busy = true; this.preview = ""; this.changed();
    let task: AgentTask | null = null;
    try {
      this.rememberLast();
      const agent = new VaultAgent(this.options.host(() => this.current && !task?.stopped), this.policy(), () => this.current && !task?.stopped);
      const input = await this.prepare(agent); if (!this.current) return;
      await this.persist(); // Draft is recoverable before the first billable request.
      task = this.createTask(agent); this.task = task; this.agent = agent; this.lastRequest = this.prompt;
      const unsubscribe = task.subscribe(() => { this.changed(); });
      try { await task.run(input, { ...this.model }, this.mode, this.maximum); }
      finally { unsubscribe(); }
      if (!this.current) return;
      this.message = task.message;
      if (this.source && agent.policy.sourcePath) this.source.path = agent.policy.sourcePath;
      if (task.text || agent.journal.operations.some(op => op.status === "done")) this.prompt = "";
      if (agent.journal.operations.length) {
        agent.journal.status = task.stopped || task.events.some(e => e.kind === "blocked") ? "interrupted" : "complete";
        await this.options.host(() => this.current).persist(agent.journal);
        this.history = [agent.journal, ...this.history.filter(j => j.id !== agent.journal.id)].slice(0, 30);
      }
    } catch (error) { this.message = error instanceof Error ? error.message : "The task could not finish. No automatic retry was made."; }
    finally { this.busy = false; if (this.current) { await this.persist().catch(() => { this.message += " Local draft saving could not be confirmed."; }); this.changed(); } }
  }
  stop(): void { this.task?.stop(); this.changed(); }
  async newTask(source: WorkspaceSource | null = this.nextSource ?? this.source): Promise<void> {
    if (this.busy) return;
    this.rememberLast();
    this.prompt = ""; this.task = null; this.agent = null; this.message = "Ready. No data is sent until you start."; this.bind(source, true); await this.persist(); this.changed();
  }
  async undo(journal: WorkJournal): Promise<void> {
    if (!this.current || this.busy) return; this.busy = true; this.changed();
    try { const agent = new VaultAgent(this.options.host(() => this.current), this.policy(), () => this.current); const result = await agent.undo(journal); this.message = `Undo: ${result.restored} action(s) restored; ${result.kept} kept because recovery could not safely be confirmed. Newer user edits are preserved.`; }
    catch { this.message = "Recovery could not be confirmed. Notes and backups were kept."; }
    finally { this.busy = false; this.changed(); }
  }
  async confirmTrash(): Promise<void> {
    if (!this.agent || this.busy || !this.current) return; this.busy = true; this.changed();
    try { await this.agent.confirmTrash(); this.message = "Selected notes moved to Obsidian Trash. Original backups and Undo are available."; }
    catch (error) { this.message = error instanceof Error ? error.message : "Trash could not be confirmed. No retry was made."; }
    finally { this.busy = false; this.changed(); }
  }
  async findCalendar(): Promise<string | null> {
    if (!this.current || this.busy || !this.options.calendar || this.requestId) return null;
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
    if (!this.current || this.busy || !this.calendar || this.delivery) return;
    this.busy = true;
    try { const reply = await this.calendar.receive(id); if (!this.current || reply.version !== 3) return; this.delivery = reply; this.message = `${reply.records.length} Calendar excerpt(s) added. Local lookup made no AI request. Review before sending to OpenAI.`; }
    catch { this.message = "No verified Calendar reply yet. Approve the local search in Calendar, then check again."; }
    finally { this.busy = false; this.changed(); }
  }
  async removeCalendar(): Promise<void> { if (this.busy) return; await this.calendar?.dispose(); this.calendar = null; this.delivery = null; this.preview = ""; this.changed(); }
  persist(): Promise<void> {
    const value = { prompt: this.prompt, lastRequest: this.lastRequest, source: this.source?.path ?? null, selection: this.source?.selection, selectionVersion: this.source?.selectionVersion, mode: this.mode, readScope: this.readScope, writeScope: this.writeScope,
      outputFolder: this.outputFolder, excluded: this.excluded, maximum: this.maximum, result: this.result, previous: this.previous };
    const next = this.saveQueue.then(async () => { if (!this.current) return; await this.options.storage.save(value); }); this.saveQueue = next.catch(() => {}); return next;
  }
  dispose(): void { this.task?.stop(); this.alive = false; this.listeners.clear(); void this.calendar?.dispose(); }
}
