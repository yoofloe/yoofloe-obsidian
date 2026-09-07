export function requestUrl(options: unknown) {
  return (globalThis as unknown as { obsidianRequest: (options: unknown) => Promise<unknown> }).obsidianRequest(options);
}
export class App {}
export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class MarkdownView {}
export class WorkspaceLeaf {}
export class WorkspaceMobileDrawer {}
export class TFile {}
export class Modal {}
export class Notice { constructor(_message: string) {} }
export const Platform = { isDesktopApp: true, isMobileApp: false, isPhone: false };
export function requireApiVersion() { return true; }
export function normalizePath(value: string) { return value.replace(/\\/g, "/"); }
