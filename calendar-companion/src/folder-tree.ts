export interface FolderRow { path: string; depth: number; hasChildren: boolean; expanded: boolean }
/** Expanded branches only; search covers every path and is paged by the view. */
export function folderRows(paths: readonly string[], expanded: ReadonlySet<string>, query = ""): FolderRow[] {
  const unique = [...new Set(paths)].sort((a, b) => a.localeCompare(b));
  const children = new Map<string, string[]>();
  for (const path of unique) {
    if (!path) continue;
    const slash = path.lastIndexOf("/"), parent = slash < 0 ? "" : path.slice(0, slash);
    const siblings = children.get(parent) ?? []; siblings.push(path); children.set(parent, siblings);
  }
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) return unique.filter(path => words.every(word => (path || "Vault root").toLocaleLowerCase().includes(word)))
    .map(path => ({ path, depth: 0, hasChildren: false, expanded: false }));
  const rows: FolderRow[] = unique.includes("") ? [{ path: "", depth: 0, hasChildren: false, expanded: false }] : [];
  const visit = (parent: string, depth: number) => {
    for (const path of children.get(parent) ?? []) {
      const open = expanded.has(path), hasChildren = !!children.get(path)?.length;
      rows.push({ path, depth, hasChildren, expanded: open });
      if (hasChildren && open) visit(path, depth + 1);
    }
  };
  visit("", 0); return rows;
}
