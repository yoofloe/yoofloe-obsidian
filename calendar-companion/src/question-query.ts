import type { RecordKind } from "./record-types";

export const QUERY_VERSION = 3;
export const QUERY_REPLY_BYTES = 256 * 1024;
export const QUERY_AREAS = ["calendar", "notes", "study", "project", "garden", "flow"] as const;
export const QUERY_PERIODS = ["today", "tomorrow", "this_week", "last_week", "last_7_days", "next_7_days", "last_30_days", "custom", "any"] as const;
export const QUERY_PROFILES = ["summary", "schedule", "next_steps", "notes", "focus", "budget", "flow"] as const;
export const METRIC_KEYS = ["study_recorded_seconds", "garden_measured_seconds", "task_count", "completed_task_count", "event_count", "project_count", "stage_count", "completed_stage_count", "note_count"] as const;
export type QueryArea = typeof QUERY_AREAS[number];
export type QueryPeriod = typeof QUERY_PERIODS[number];
export type QueryProfile = typeof QUERY_PROFILES[number];
export interface QuestionQuery {
  readonly areas: readonly QueryArea[]; readonly period: QueryPeriod; readonly from: string | null; readonly through: string | null;
  readonly zone: string; readonly terms: readonly string[]; readonly profile: QueryProfile; readonly includeLinkedNotes: boolean;
  readonly maxRecords: number; readonly maxTextBytes: number;
}
export interface QuestionContext {
  scope: QuestionQuery; from: string | null; through: string | null; zone: string;
  scanned: number; matched: number; partial: boolean; metrics: { key: typeof METRIC_KEYS[number]; value: number }[];
}
export const AREA_LABELS: Record<QueryArea, string> = { calendar: "Calendar", notes: "Notes", study: "Study", project: "Project", garden: "Garden", flow: "Flow" };
export const PERIOD_LABELS: Record<QueryPeriod, string> = { today: "Today", tomorrow: "Tomorrow", this_week: "This week", last_week: "Last week", last_7_days: "Last 7 days", next_7_days: "Next 7 days", last_30_days: "Last 30 days", custom: "Specific dates", any: "Any date · matching topic" };
const encoder = new TextEncoder();
function closed(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== fields.sort().join("|")) throw Error("Unsupported question-search format.");
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T { return typeof value === "string" && choices.includes(value as T); }
export function civilDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function validZone(value: unknown): value is string {
  if (typeof value !== "string" || encoder.encode(value).length > 80 || !value || value.includes(":")) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
}

/** Queries are closed, bounded filters, never executable SQL or model-provided paths. */
export function validateQuestionQuery(value: unknown): QuestionQuery {
  closed(value, ["areas", "period", "from", "through", "zone", "terms", "profile", "includeLinkedNotes", "maxRecords", "maxTextBytes"]);
  if (!Array.isArray(value.areas) || value.areas.length < 1 || value.areas.length > 6 || !value.areas.every(area => member(area, QUERY_AREAS)) || new Set(value.areas).size !== value.areas.length) throw Error("Choose at least one workspace to search.");
  if (!member(value.period, QUERY_PERIODS) || !member(value.profile, QUERY_PROFILES) || !validZone(value.zone) || typeof value.includeLinkedNotes !== "boolean") throw Error("Choose a supported search period and workspace.");
  if (!Array.isArray(value.terms) || value.terms.length > 8 || value.terms.some(term => typeof term !== "string" || !term || [...term].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || term !== term.trim().normalize("NFC").toLowerCase() || encoder.encode(term).length > 80) || new Set(value.terms).size !== value.terms.length) throw Error("The search topic is invalid or too long.");
  if (value.period === "custom" ? !civilDate(value.from) || !civilDate(value.through) || value.from > value.through : value.from !== null || value.through !== null) throw Error("Choose valid dates for this search.");
  if (value.period === "any" && !value.terms.length && !["next_steps", "flow"].includes(value.profile)) throw Error("Add a topic or choose a date range.");
  if ((value.profile === "budget" && !value.areas.includes("project")) || (value.profile === "flow" && !value.areas.includes("flow"))) throw Error("This search profile does not match its workspace.");
  if (!Number.isInteger(value.maxRecords) || (value.maxRecords as number) < 1 || (value.maxRecords as number) > 20 || !Number.isInteger(value.maxTextBytes) || (value.maxTextBytes as number) < 1 || (value.maxTextBytes as number) > 32768) throw Error("This search exceeds its data budget.");
  return Object.freeze({ ...value, areas: Object.freeze([...value.areas]), terms: Object.freeze([...(value.terms as string[])]) }) as unknown as QuestionQuery;
}

export function kindAllowed(query: QuestionQuery, kind: RecordKind): boolean {
  if (kind === "asset" || ["note_link", "study_link", "project_link", "focus_context", "study_focus", "project_focus"].includes(kind)) return false;
  if (kind === "note") return query.areas.includes("notes") || query.includeLinkedNotes;
  if (kind.startsWith("flow_")) return query.areas.includes("flow");
  if (["study_session", "study_plan", "study_milestone", "study_lecture", "study_semester"].includes(kind)) return query.areas.includes("study");
  if (["project", "project_stage", "project_income", "project_expense", "project_rate"].includes(kind)) return query.areas.includes("project") && (!["project_income", "project_expense", "project_rate"].includes(kind) || query.profile === "budget");
  if (kind === "focus_session") return query.areas.includes("garden");
  return query.areas.includes("calendar") && ["event", "task", "dday"].includes(kind);
}

export function resolvePeriod(query: QuestionQuery, createdAt: number): { from: string | null; through: string | null } {
  if (query.period === "any") return { from: null, through: null };
  if (query.period === "custom") return { from: query.from, through: query.through };
  const parts = new Intl.DateTimeFormat("en", { timeZone: query.zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(createdAt);
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? "";
  const today = Date.parse(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  const date = (offset: number) => new Date(today + offset * 86400000).toISOString().slice(0, 10);
  const monday = -((new Date(today).getUTCDay() + 6) % 7);
  const offsets: Record<Exclude<QueryPeriod, "custom" | "any">, [number, number]> = {
    today: [0, 0], tomorrow: [1, 1], this_week: [monday, monday + 6], last_week: [monday - 7, monday - 1],
    last_7_days: [-6, 0], next_7_days: [0, 6], last_30_days: [-29, 0],
  };
  const [from, through] = offsets[query.period]; return { from: date(from), through: date(through) };
}

export function validateQuestionContext(value: unknown, query: QuestionQuery, recordCount: number, createdAt?: number): QuestionContext {
  closed(value, ["scope", "from", "through", "zone", "scanned", "matched", "partial", "metrics"]);
  const scope = validateQuestionQuery(value.scope);
  if (JSON.stringify(scope) !== JSON.stringify(query) && !queryEqual(scope, query)) throw Error("The returned search scope changed.");
  if (value.zone !== query.zone || (query.period === "any" ? value.from !== null || value.through !== null : !civilDate(value.from) || !civilDate(value.through) || value.from > value.through)) throw Error("The returned search period is invalid.");
  if (query.period === "custom" && (value.from !== query.from || value.through !== query.through)) throw Error("The returned search dates changed.");
  if (createdAt !== undefined) { const dates = resolvePeriod(query, createdAt); if (dates.from !== value.from || dates.through !== value.through) throw Error("The returned search dates changed."); }
  if (!Number.isInteger(value.scanned) || (value.scanned as number) < 0 || (value.scanned as number) > 512 || !Number.isInteger(value.matched) || (value.matched as number) < recordCount || (value.matched as number) > (value.scanned as number) || typeof value.partial !== "boolean") throw Error("The search coverage is invalid.");
  if (!Array.isArray(value.metrics) || value.metrics.length > 9) throw Error("The search totals are invalid.");
  const seen = new Set<string>();
  for (const metric of value.metrics) {
    closed(metric, ["key", "value"]);
    if (!member(metric.key, METRIC_KEYS) || seen.has(metric.key) || !Number.isSafeInteger(metric.value) || (metric.value as number) < 0) throw Error("The search totals are invalid.");
    const area: QueryArea = metric.key.startsWith("study_") ? "study" : metric.key.startsWith("garden_") ? "garden" : metric.key.includes("task_") || metric.key === "event_count" ? "calendar" : metric.key.includes("stage_") || metric.key === "project_count" ? "project" : "notes";
    if (!query.areas.includes(area) && !(area === "notes" && query.includeLinkedNotes)) throw Error("A search total is outside the approved workspace.");
    seen.add(metric.key);
  }
  if ((value.matched as number) > recordCount && !value.partial) throw Error("The search omitted records without declaring partial coverage.");
  return { ...value, scope } as unknown as QuestionContext;
}
export function queryEqual(a: QuestionQuery, b: QuestionQuery): boolean {
  return a.period === b.period && a.from === b.from && a.through === b.through && a.zone === b.zone && a.profile === b.profile && a.includeLinkedNotes === b.includeLinkedNotes && a.maxRecords === b.maxRecords && a.maxTextBytes === b.maxTextBytes && a.areas.join("|") === b.areas.join("|") && a.terms.join("|") === b.terms.join("|");
}

/** Local intent/date routing; no model, embedding service or record body is used to plan a search. */
export function planQuestion(question: string, overrides: { areas?: readonly QueryArea[]; period?: QueryPeriod; terms?: readonly string[]; zone?: string } = {}, now = Date.now()): { query: QuestionQuery | null; needsArea: boolean; terms: string[] } {
  const text = question.trim().normalize("NFC").toLowerCase();
  if (!text || encoder.encode(question).length > 4000) throw Error("Enter a question of at most 4000 UTF-8 bytes.");
  const areas: QueryArea[] = [];
  const hints: [QueryArea, RegExp][] = [
    ["calendar", /calendar|schedule|events?|tasks?|todo|일정|캘린더|할\s?일|kalendarz|zadani|wydarze/],
    ["notes", /notes?|memo|journal|노트|메모|일기|notatk/],
    ["study", /study|studies|learn|lecture|semester|학습|공부|강의|수업|nauk|lekcj|studia/],
    ["project", /project|milestone|budget|expense|income|프로젝트|단계|예산|비용|수입|지출|projekt|budżet|koszt/],
    ["garden", /focus|pomodoro|garden|집중|포모도로|skupien/],
    ["flow", /\bflow\b|avatar|character|\bpets?\b|아바타|캐릭터|펫|반려|성장|postać/],
  ];
  hints.forEach(([area, pattern]) => { if (pattern.test(text)) areas.push(area); });
  const selected = overrides.areas ? [...overrides.areas] : areas;
  let profile: QueryProfile = /budget|expense|income|예산|비용|수입|지출|budżet|koszt/.test(text) ? "budget" : /next|priority|다음|우선|następn/.test(text) ? "next_steps" : selected.length === 1 && selected[0] === "flow" ? "flow" : selected.length === 1 && selected[0] === "calendar" ? "schedule" : selected.length === 1 && selected[0] === "garden" ? "focus" : selected.length === 1 && selected[0] === "notes" ? "notes" : "summary";
  if (profile === "budget" && !selected.includes("project")) profile = "summary";
  let period: QueryPeriod = /tomorrow|내일|jutro/.test(text) ? "tomorrow" : /today|오늘|dzisiaj|dziś/.test(text) ? "today" : /last\s*week|지난\s*주|zeszł/.test(text) ? "last_week" : /this\s*week|이번\s*주|tym tygodniu/.test(text) ? "this_week" : /next\s*week|다음\s*주/.test(text) ? "next_7_days" : /30\s*days|30일|30 dni/.test(text) ? "last_30_days" : /7\s*days|7일|7 dni/.test(text) ? "last_7_days" : profile === "next_steps" || profile === "flow" ? "any" : profile === "schedule" ? "next_7_days" : profile === "notes" || profile === "budget" ? "last_30_days" : "last_7_days";
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g)?.filter(civilDate) ?? [];
  let zone = "UTC"; try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* UTC fallback. */ }
  if (overrides.zone && validZone(overrides.zone)) zone = overrides.zone;
  const nextWeek = !dates.length && !overrides.period && /next\s*week|다음\s*주|przyszł[^ ]*\s+tygod/.test(text);
  if (!dates.length && !overrides.period && /(?:next|coming|upcoming)\s*7\s*days|(?:앞으로|향후|다음)\s*7\s*일|następn[^ ]*\s*7\s*dni/.test(text)) period = "next_7_days";
  if (nextWeek) {
    const week = resolvePeriod({ period: "this_week", zone } as QuestionQuery, now);
    const add = (date: string, days: number) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
    dates.push(add(week.from!, 7), add(week.through!, 7));
  }
  if (dates.length) period = "custom";
  if (overrides.period) period = overrides.period;
  const topic = text.replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/지난\s*주|이번\s*주|다음\s*주|오늘|내일|최근|학습|공부|강의|수업|일정|캘린더|할\s?일|노트|메모|일기|프로젝트|단계|예산|비용|수입|지출|집중|포모도로|아바타|캐릭터|반려|성장|정리해\s?줘|정리|요약해\s?줘|요약|알려\s?줘|알려|보여\s?줘|보여|다음|우선|계획|시간|기록|현황/g, " ");
  const stop = /^(the|a|an|my|me|i|and|or|to|for|of|in|on|with|from|please|summari[sz]e|summary|review|show|what|how|did|do|have|has|this|last|next|week|days?|today|tomorrow|recent|study|studies|learning|learn|sessions?|records?|calendar|schedule|events?|tasks?|todo|notes?|memo|journal|project|projects|progress|milestones?|budget|expense|income|focus|pomodoro|garden|flow|avatar|character|pets?|plan|plans|time|minutes|hours|w|i|z|na|do|moje|mój|tym|tygodniu|zeszłym|nauka|naukę|notatki|projektu|projekty|zadania|podsumuj|pokaż|skupienie|dni)$/;
  const generic = /^(should|would|could|can|is|are|was|were|need|needs|attention|help|prepare|create|write|give|list|status|overview|remaining|upcoming|spent|logged|recorded|completed|pending|across|so|far|doing|done|analy[sz]e|compare|between|much|many|about|어떻게|얼마나|어땠어|했어|했는지|관련|전체|모두|내용)$/;
  const terms = overrides.terms ? [...overrides.terms] : [...new Set((topic.match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []).map(term => term.replace(/(에서|으로|에게|들은|들을|을|를|의|은|는)$/u, "")).filter(term => term.length > 1 && !/^\d+$/.test(term) && !stop.test(term) && !generic.test(term) && encoder.encode(term).length <= 80))].slice(0, 8);
  if (!selected.length) return { query: null, needsArea: true, terms };
  return { query: validateQuestionQuery({ areas: selected, period, from: period === "custom" ? dates[0] ?? null : null, through: period === "custom" ? dates[dates.length - 1] ?? null : null, zone, terms, profile, includeLinkedNotes: !selected.includes("flow"), maxRecords: 20, maxTextBytes: 32768 }), needsArea: false, terms };
}
