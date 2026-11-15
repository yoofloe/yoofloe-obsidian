
import type { TransferStore } from "./session";

export interface CalendarTransferFile { name: string; contents: string }

export function temporaryCalendarTransferStore(): TransferStore {
  const folders = new Set<string>();
  const files = new Map<string, string>();
  const encoder = new TextEncoder();
  return {
    exists: path => Promise.resolve(folders.has(path) || files.has(path)),
    mkdir: path => { folders.add(path); return Promise.resolve(); },
    write: (path, value) => { files.set(path, value); return Promise.resolve(); },
    read: path => {
      const value = files.get(path);
      return value === undefined ? Promise.reject(Error("No Calendar file at this path.")) : Promise.resolve(value);
    },
    size: path => {
      const value = files.get(path);
      return Promise.resolve(value === undefined ? null : encoder.encode(value).byteLength);
    },
    remove: path => { files.delete(path); return Promise.resolve(); },
  };
}

export function downloadCalendarTransfer(container: HTMLElement, file: CalendarTransferFile | null): void {
  const win = container.ownerDocument.defaultView;
  if (!win || !file) return;
  const url = win.URL.createObjectURL(new win.Blob([file.contents], { type: "application/json" }));
  const link = container.createEl("a", { attr: { href: url, download: file.name } });
  link.hidden = true;
  try { link.click(); }
  finally { link.remove(); win.setTimeout(() => win.URL.revokeObjectURL(url), 1000); }
}

/** The user selects a single exact reply. It stays in memory until the session authenticates it. */
export function pickCalendarTransfer(container: HTMLElement, name: string, maximum: number, label = "Import Calendar reply"): Promise<CalendarTransferFile | null> {
  return new Promise((resolve, reject) => {
    const input = container.createEl("input", { type: "file", attr: { accept: ".json", "aria-label": label } });
    input.hidden = true;
    input.addEventListener("cancel", () => { input.remove(); resolve(null); }, { once: true });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) { resolve(null); return; }
      if (file.name !== name || file.size < 1 || file.size > maximum) {
        reject(Error("Choose the matching Calendar reply file for this request."));
        return;
      }
      void file.text().then(contents => resolve({ name: file.name, contents }), reject);
    }, { once: true });
    try { input.click(); }
    catch (error) { input.remove(); reject(error instanceof Error ? error : Error("The file picker could not be opened.")); }
  });
}
