/** Mirrors Calendar's closed content catalog; checked against the native interop fixture. */
export const RECORD_TYPES = [
  ["note", "Notes", "Notes"], ["note_folder", "Notes", "Note folders"],
  ["task", "Calendar", "Tasks and task folders"], ["event", "Calendar", "Events"],
  ["dday", "Calendar", "D-Days"], ["event_template", "Calendar", "Event templates"],
  ["study_session", "Study", "Study sessions"], ["study_folder", "Study", "Study folders"],
  ["study_semester", "Study", "Semesters"], ["study_lecture", "Study", "Lectures"],
  ["study_plan", "Study", "Study plans"], ["study_milestone", "Study", "Study milestones"],
  ["project_folder", "Project", "Project folders"], ["project", "Project", "Projects"],
  ["project_stage", "Project", "Project stages"], ["project_income", "Project", "Income entries"],
  ["project_expense", "Project", "Expense entries"], ["project_rate", "Project", "Exchange-rate entries"],
  ["focus_session", "Garden", "Focus and break history"], ["garden_background", "Garden", "Garden background reference"],
  ["note_link", "Relationships", "Planner note links"], ["study_link", "Relationships", "Study links"],
  ["project_link", "Relationships", "Project links"], ["focus_context", "Relationships", "Focus contexts"],
  ["study_focus", "Relationships", "Study focus bindings"], ["project_focus", "Relationships", "Project focus bindings"],
  ["asset", "Media", "Attachment metadata"], ["flow_profile", "Flow", "Avatar and environment"],
  ["flow_actor", "Flow", "Characters and pets"], ["flow_place", "Flow", "Places and decorations"],
  ["flow_assignment", "Flow", "Context assignments"], ["flow_focus_binding", "Flow", "Flow focus bindings"],
  ["flow_progress", "Flow", "Progress history"], ["flow_wallet", "Flow", "Point history"],
  ["flow_ownership", "Flow", "Owned content identifiers"], ["flow_career", "Flow", "Career context history"],
] as const;
export type RecordKind = typeof RECORD_TYPES[number][0];
const kinds = new Set<string>(RECORD_TYPES.map(type => type[0]));
/** Accept only an explicitly supported record type. */
export function isRecordKind(value: unknown): value is RecordKind { return typeof value === "string" && kinds.has(value); }
/** Show a readable workspace and type name in previews. */
export function recordLabel(kind: RecordKind): string { const type = RECORD_TYPES.find(type => type[0] === kind)!; return `${type[1]} · ${type[2]}`; }
