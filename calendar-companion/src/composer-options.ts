import { Menu, Modal, Platform, setIcon, setTooltip, type App } from "obsidian";
import { modelCatalog } from "./ai-models";
import type { AiModelOptions } from "./ai-session";
import { EFFORT_LABELS, resolveEffort, supportedEfforts, type EffortSetting } from "./effort";
import { SOURCE_MODES, supportsHostedTools, type SourceMode } from "./research";
import { availableViewHeight } from "./view-bounds";
import type { AiWorkspace } from "./workspace";

const PICKER_LABEL = { model: "Model", effort: "Thinking depth", source: "Source mode" } as const;
const SOURCE_LABELS: Record<SourceMode, string> = { expanded: "Expanded", provided: "Provided only" };
type Picker = keyof typeof PICKER_LABEL;
type PickerChoice = { label: string; current?: boolean; apply?: () => void | Promise<void>; custom?: boolean };
const PROMPT_SELECTOR = ".y-ai-primary-prompt, .y-ai-follow-up-input";
type Caret = { field: ".y-ai-primary-prompt" | ".y-ai-follow-up-input"; from: number; to: number };

function selectedEffort(model: Readonly<AiModelOptions>): EffortSetting {
  return model.effort ?? resolveEffort(model.model) ?? "default";
}

function fitMobilePicker(container: HTMLElement): () => void {
  const doc = container.ownerDocument, win = doc.defaultView;
  if (!win) return () => {};
  const viewport = win.visualViewport;
  const navbars = Array.from(doc.querySelectorAll<HTMLElement>(".mobile-navbar"));
  const resize = () => {
    const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
    const height = viewport?.height ?? win.innerHeight;
    const keyboard = parseFloat(win.getComputedStyle(doc.body).getPropertyValue("--keyboard-height")) || 0;
    const bottom = top + height - (win.innerHeight - height > 80 ? 0 : keyboard);
    const pane = { top, left, bottom, right: left + (viewport?.width ?? win.innerWidth) };
    const overlays = navbars.filter(bar => {
      const style = win.getComputedStyle(bar);
      return style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
    }).map(bar => bar.getBoundingClientRect());
    container.style.top = `${top}px`;
    container.style.height = `${availableViewHeight(pane, bottom, bottom, overlays)}px`;
  };
  const styles = new win.MutationObserver(resize);
  for (const el of [doc.body, doc.documentElement, ...navbars]) styles.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
  const geometry = new win.ResizeObserver(resize);
  for (const bar of navbars) geometry.observe(bar);
  viewport?.addEventListener("resize", resize);
  viewport?.addEventListener("scroll", resize);
  win.addEventListener("resize", resize);
  resize();
  return () => {
    styles.disconnect(); geometry.disconnect();
    viewport?.removeEventListener("resize", resize);
    viewport?.removeEventListener("scroll", resize);
    win.removeEventListener("resize", resize);
  };
}

export class ComposerOptions {
  private openPicker: { close(): void; button: HTMLButtonElement; closed(): void } | null = null;
  private fitted: { group: HTMLElement; inputs: string } | null = null;

  constructor(private readonly app: App, private readonly root: HTMLElement, private readonly getWork: () => AiWorkspace,
    private readonly openSettings: () => void, private readonly saveSourceMode: () => void) {}

  render(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "y-ai-composer-options", attr: { role: "group", "aria-label": "Request options" } });
    for (const kind of ["model", "effort", "source"] as const) {
      const button = group.createEl("button", { cls: "y-ai-option-picker", attr: {
        type: "button", "data-composer-picker": kind, "aria-haspopup": Platform.isMobileApp ? "dialog" : "menu", "aria-expanded": "false",
      } });
      button.createSpan({ cls: "y-ai-picker-value" });
      setIcon(button.createSpan({ cls: "y-ai-picker-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
      let caret: Caret | undefined;
      button.addEventListener("pointerdown", event => {
        caret = undefined;
        const active = this.root.ownerDocument.activeElement as HTMLTextAreaElement | null;
        if (event.button !== 0 || !active?.matches(PROMPT_SELECTOR) || !this.root.contains(active)) return;
        caret = { field: active.matches(".y-ai-follow-up-input") ? ".y-ai-follow-up-input" : ".y-ai-primary-prompt",
          from: active.selectionStart, to: active.selectionEnd };
        event.preventDefault();
      });
      button.addEventListener("click", event => {
        const previous = event.detail > 0 ? caret : undefined;
        caret = undefined;
        this.show(kind, button, previous);
      });
    }
  }

  refresh(): void {
    const work = this.getWork();
    const task = work.task;
    const model = task && (task.busy || work.canContinue) ? task.modelOptions : work.model;
    const known = modelCatalog("openai").models.find(item => item.id === model.model);
    const values = { model: known?.label ?? (model.model ? `Custom · ${model.model}` : "Choose a model"),
      effort: EFFORT_LABELS[selectedEffort(model)], source: SOURCE_LABELS[work.sourceMode] };
    const disabled = !work.current || work.settingsLocked || work.modelSaving;
    this.root.querySelectorAll<HTMLButtonElement>("[data-composer-picker]").forEach(button => {
      const kind = button.dataset.composerPicker as Picker;
      const value = values[kind];
      const label = button.querySelector(".y-ai-picker-value");
      const text = kind === "model" && !known && model.model ? "Custom model" : value;
      if (label && label.textContent !== text) label.setText(text);
      const accessibleLabel = `${PICKER_LABEL[kind]}: ${value}`;
      if (button.getAttribute("aria-label") !== accessibleLabel) {
        button.setAttribute("aria-label", accessibleLabel);
        if (kind === "source") setTooltip(button, SOURCE_MODES[work.sourceMode]);
        if (kind === "model") setTooltip(button, value);
      }
      button.disabled = disabled;
    });
    if (disabled) this.close();
  }

  fitLabels(): void {
    const win = this.root.ownerDocument.defaultView;
    const group = this.root.querySelector<HTMLElement>(".y-ai-composer-options");
    const row = group?.parentElement;
    if (!win || !group || !row?.clientWidth) return;
    const width = row.clientWidth;
    const rowGap = parseFloat(win.getComputedStyle(row).columnGap) || 0;
    const otherControls = Array.from(row.children).filter(control => control !== group && control.getClientRects().length);
    const inlineWidth = otherControls.reduce((room, control) => room - control.getBoundingClientRect().width - rowGap, width);
    const followUp = row.classList.contains("y-ai-follow-up-controls");
    const style = win.getComputedStyle(group);
    const inputs = [width, inlineWidth, followUp, style.font, style.getPropertyValue("--font-ui-small"), group.textContent].join("|");
    if (this.fitted?.group === group && this.fitted.inputs === inputs) return;
    this.fitted = { group, inputs };

    // Measure unwrapped labels at the theme size and keep all three at the same size.
    group.style.removeProperty("--y-ai-picker-font-size");
    const buttons = Array.from(group.children);
    const baseSize = parseFloat(win.getComputedStyle(buttons[0]).fontSize);
    const sumWidths = (items: ArrayLike<Element>) => Array.from(items).reduce((sum, item) => sum + item.getBoundingClientRect().width, 0);
    const scalableWidth = sumWidths(group.querySelectorAll(".y-ai-picker-value, .y-ai-picker-chevron"));
    const gapWidth = (parseFloat(style.columnGap) || 0) * (buttons.length - 1);
    const fixedWidth = sumWidths(buttons) + gapWidth - scalableWidth;
    const fit = (room: number) => Math.min(baseSize, Math.floor(4 * baseSize * (room - fixedWidth - 1) / scalableWidth) / 4);
    const fullRow = followUp || fit(inlineWidth) < Math.min(10.5, baseSize);
    group.classList.toggle("is-full-row", fullRow);
    const size = Math.max(Math.min(10, baseSize), fit(fullRow ? width : inlineWidth));
    group.style.setProperty("--y-ai-picker-font-size", `${size}px`);
  }

  close(): void {
    const open = this.openPicker;
    if (!open) return;
    this.openPicker = null;
    open.button.setAttribute("aria-expanded", "false");
    open.close();
  }

  private choices(kind: Picker, work: AiWorkspace): PickerChoice[] {
    const choices: PickerChoice[] = [];
    if (kind === "model") {
      const models = modelCatalog("openai").models;
      for (const model of models) choices.push({ label: model.label, current: work.model.model === model.id, apply: () => work.setModel({ model: model.id }) });
      if (work.model.model && !models.some(model => model.id === work.model.model))
        choices.push({ label: `Custom · ${work.model.model}`, current: true, apply: () => {} });
      if (work.model.model && !supportsHostedTools(work.model.model))
        choices.push({ label: "Hosted web, analysis and image tools unavailable" });
      choices.push({ label: "Custom model…", custom: true, apply: this.openSettings });
    } else if (kind === "effort") {
      const selected = selectedEffort(work.model);
      const efforts: EffortSetting[] = ["default", ...supportedEfforts(work.model.model)];
      for (const effort of efforts) choices.push({ label: EFFORT_LABELS[effort], current: effort === selected, apply: () => work.setModel({ ...work.model, effort }) });
    } else {
      for (const mode of ["expanded", "provided"] as const) choices.push({ label: SOURCE_LABELS[mode], current: work.sourceMode === mode, apply: () => {
        work.setSourceMode(mode);
        this.saveSourceMode();
      } });
    }
    return choices;
  }

  private show(kind: Picker, button: HTMLButtonElement, caret: Caret | undefined): void {
    const work = this.getWork();
    if (!work.current || work.settingsLocked || work.modelSaving) return;
    this.close();
    const doc = this.root.ownerDocument;
    const conversation = work.library.active;
    const restoreFocus = () => {
      if (!this.root.isConnected || this.openPicker || this.getWork() !== work || work.library.active !== conversation) return;
      const picker = this.root.querySelector<HTMLButtonElement>(`[data-composer-picker="${kind}"]`);
      const input = caret && this.root.querySelector<HTMLTextAreaElement>(caret.field);
      const active = doc.activeElement;
      if (active && active !== doc.body && active !== button && active !== picker && active !== input) return;
      if (caret && input && !input.disabled) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(caret.from, caret.to);
      } else if (picker && !picker.disabled) picker.focus({ preventScroll: true });
    };
    const choose = (choice: PickerChoice) => {
      if (this.openPicker?.closed !== closed) return;
      this.close();
      if (choice.current) restoreFocus();
      else if (choice.custom) void choice.apply?.();
      else void Promise.resolve(choice.apply?.()).then(restoreFocus);
    };
    const closed = () => {
      if (this.openPicker?.closed !== closed) return;
      this.openPicker = null;
      button.setAttribute("aria-expanded", "false");
      doc.defaultView?.requestAnimationFrame(restoreFocus);
    };
    const choices = this.choices(kind, work);
    button.setAttribute("aria-expanded", "true");
    if (Platform.isMobileApp) {
      if (caret) {
        this.root.querySelector<HTMLTextAreaElement>(caret.field)?.blur();
        button.focus({ preventScroll: true });
      }
      this.showMobilePicker(kind, button, choices, choose, closed);
    } else {
      const menu = new Menu();
      for (const choice of choices) {
        if (choice.custom) menu.addSeparator();
        menu.addItem(item => {
          item.setTitle(choice.label);
          if (choice.current !== undefined) item.setChecked(choice.current);
          if (choice.apply) item.onClick(() => choose(choice));
          else item.setDisabled(true);
        });
      }
      this.openPicker = { close: () => menu.hide(), button, closed };
      menu.onHide(closed);
      const anchor = button.getBoundingClientRect();
      menu.showAtPosition({ x: anchor.left, y: anchor.bottom }, doc);
    }
  }

  private showMobilePicker(kind: Picker, trigger: HTMLButtonElement, choices: PickerChoice[], choose: (choice: PickerChoice) => void, closed: () => void): void {
    const modal = new Modal(this.app);
    modal.setTitle(PICKER_LABEL[kind]);
    modal.modalEl.setAttribute("aria-label", PICKER_LABEL[kind]);
    modal.modalEl.classList.add("y-ai-picker-modal");
    modal.containerEl.classList.add("y-ai-picker-container");
    for (const choice of choices) {
      if (!choice.apply) { modal.contentEl.createEl("p", { cls: "y-ai-picker-hint", text: choice.label }); continue; }
      const option = modal.contentEl.createEl("button", { cls: "y-ai-picker-choice", attr: { type: "button" } });
      option.createSpan({ text: choice.label });
      if (choice.current !== undefined) option.setAttribute("aria-pressed", String(choice.current));
      if (choice.current) setIcon(option.createSpan({ cls: "y-ai-picker-check", attr: { "aria-hidden": "true" } }), "check");
      option.addEventListener("click", () => choose(choice));
    }
    this.openPicker = { close: () => modal.close(), button: trigger, closed };
    let stopViewport = () => {};
    modal.setCloseCallback(() => { stopViewport(); closed(); });
    modal.open();
    stopViewport = fitMobilePicker(modal.containerEl);
  }
}
