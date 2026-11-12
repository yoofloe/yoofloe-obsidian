export type WorkScope = "current" | "folder" | "vault";
export type WriteScope = WorkScope | "new";
export type WorkMode = "ask" | "edit" | "organize" | "all";
export interface TaskPolicy { sourcePath: string | null; folder: string; readScope: WorkScope; writeScope: WriteScope; mode: WorkMode; configDir: string; excluded: readonly string[]; selection?: { from: number; to: number }; selectionVersion?: string }
export const SCOPE_LABELS: Record<WorkScope, string> = { current: "Current note", folder: "Note folder", vault: "Vault" };
export const WRITE_SCOPE_LABELS: Record<WriteScope, string> = { current: "Current note", new: "New documents", folder: "Note folder", vault: "Vault" };
export const MODE_LABELS: Record<WorkMode, string> = { ask: "Ask only", edit: "Write and edit", organize: "Organize notes", all: "All actions" };
export function vaultPath(raw: string, folder = false): string {
  if (typeof raw !== "string" || raw.length > 500 || raw.startsWith("/") || raw.includes("\\") || raw.includes(":") || [...raw].some(c => c.charCodeAt(0) < 32)) throw Error("Choose a path inside this vault.");
  const parts = raw.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || /[<>|?*]/.test(p))) throw Error("Hidden, parent and invalid paths are not available to AI tools.");
  if (!folder && !raw.toLowerCase().endsWith(".md")) throw Error("This tool works with Markdown notes.");
  return raw;
}
const inside = (path: string, root: string) => path === root || path.startsWith(root + "/");
/** Path hygiene only. A valid path does not grant read or write permission. */
export function validTaskPath(policy: TaskPolicy, path: string, allowNonMarkdown = false): boolean {
  try { vaultPath(path, allowNonMarkdown); } catch { return false; }
  // Block case aliases conservatively; permission scopes below still require exact paths.
  const blockedPath = path.toLowerCase();
  return !(inside(blockedPath, policy.configDir.toLowerCase()) || /^(?:Yoofloe AI\/(?:Backups|History)|Yoofloe Calendar\/(?:AI backups|AI drafts|Inbox))(?:\/|$)/i.test(path) || policy.excluded.some(root => inside(blockedPath, root.toLowerCase())));
}
export function allowedPath(policy: TaskPolicy, path: string, action: "read" | "edit" | "create" | "organize", attachment = false): boolean {
  if (!validTaskPath(policy, path, attachment || action === "organize" && !path.endsWith(".md"))) return false;
  if (action !== "read" && policy.mode === "ask" || action === "organize" && policy.mode !== "organize" && policy.mode !== "all") return false;
  if (action === "create") return policy.writeScope !== "current" && (!policy.folder || inside(path, policy.folder));
  const scope = action === "read" ? policy.readScope : policy.writeScope;
  if (scope === "vault") return true;
  if (scope === "new") return false; // Only identity-bound notes created by this task may be revised.
  if (scope === "folder") return !policy.folder || inside(path, policy.folder);
  return path === policy.sourcePath;
}
/** Checks only the material about to leave the device, without sending a classifier request. */
export function containsCredential(text: string): boolean {
  return /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\bAIza[A-Za-z0-9_-]{25,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text);
}
export function safeOutbound(text: string): string {
  if (containsCredential(text)) throw Error("A possible API key or private key was found. This material was not sent. Remove it or choose other notes.");
  return text;
}
export function closedObject(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) throw Error("Unsupported tool arguments.");
}
export function textField(value: unknown, maximum = 500): string { if (typeof value !== "string" || value.length > maximum) throw Error("Invalid text argument."); return value; }
