import { Menu, Platform, setIcon, setTooltip } from "obsidian";
import { modelCatalog } from "./ai-models";
import type { AiModelOptions } from "./ai-session";
import { EFFORT_LABELS, resolveEffort, supportedEfforts, type EffortSetting } from "./effort";
import { SOURCE_MODES, supportsHostedTools, type SourceMode } from "./research";
import type { AiWorkspace } from "./workspace";

const PICKER_LABEL = { model: "Model", effort: "Thinking depth", source: "Source mode" } as const;
const SOURCE_LABELS: Record<SourceMode, string> = { expanded: "Expanded", provided: "Provided only" };
type Picker = keyof typeof PICKER_LABEL;
const PROMPT_SELECTOR = ".y-ai-primary-prompt, .y-ai-follow-up-input";
type Caret = { field: ".y-ai-primary-prompt" | ".y-ai-follow-up-input"; from: number; to: number };

function selectedEffort(model: Readonly<AiModelOptions>): EffortSetting {
  return model.effort ?? resolveEffort(model.model) ?? "default";
}

export class ComposerOptions {
  private openMenu: { menu: Menu; button: HTMLButtonElement } | null = null;
  private fitted: { group: HTMLElement; inputs: string } | null = null;

  constructor(private readonly root: HTMLElement, private readonly getWork: () => AiWorkspace,
    private readonly openSettings: () => void, private readonly saveSourceMode: () => void) {}

  render(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "y-ai-composer-options", attr: { role: "group", "aria-label": "Request options" } });
    for (const kind of ["model", "effort", "source"] as const) {
      const button = group.createEl("button", { cls: "y-ai-option-picker", attr: {
        type: "button", "data-composer-picker": kind, "aria-haspopup": "menu", "aria-expanded": "false",
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
    const open = this.openMenu;
    if (!open) return;
    this.openMenu = null;
    open.button.setAttribute("aria-expanded", "false");
    open.menu.hide();
  }

  private show(kind: Picker, button: HTMLButtonElement, caret: Caret | undefined): void {
    const work = this.getWork();
    if (!work.current || work.settingsLocked || work.modelSaving) return;
    this.close();
    const menu = new Menu();
    const conversation = work.library.active;
    let chosen = false;
    const restoreFocus = () => {
      if (!this.root.isConnected || this.openMenu || this.getWork() !== work || work.library.active !== conversation) return;
      const picker = this.root.querySelector<HTMLButtonElement>(`[data-composer-picker="${kind}"]`);
      const input = caret && this.root.querySelector<HTMLTextAreaElement>(caret.field);
      const active = this.root.ownerDocument.activeElement;
      if (active && active !== this.root.ownerDocument.body && active !== button && active !== picker && active !== input) return;
      if (caret && input && !input.disabled) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(caret.from, caret.to);
      } else if (picker && !picker.disabled) picker.focus({ preventScroll: true });
    };
    const select = (label: string, current: boolean, apply: () => void | Promise<void>) => {
      menu.addItem(item => item.setTitle(label).setChecked(current).onClick(() => {
        chosen = true;
        this.close();
        if (current) restoreFocus();
        else void Promise.resolve(apply()).then(restoreFocus);
      }));
    };
    if (kind === "model") {
      const models = modelCatalog("openai").models;
      for (const model of models) select(model.label, work.model.model === model.id, () => work.setModel({ model: model.id }));
      if (work.model.model && !models.some(model => model.id === work.model.model))
        select(`Custom · ${work.model.model}`, true, () => {});
      if (work.model.model && !supportsHostedTools(work.model.model))
        menu.addItem(item => item.setTitle("Hosted web, analysis and image tools unavailable").setDisabled(true));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("Custom model…").onClick(() => {
        chosen = true;
        this.close();
        this.openSettings();
      }));
    } else if (kind === "effort") {
      const selected = selectedEffort(work.model);
      const choices: EffortSetting[] = ["default", ...supportedEfforts(work.model.model)];
      for (const effort of choices) select(EFFORT_LABELS[effort], effort === selected, () => work.setModel({ ...work.model, effort }));
    } else {
      for (const mode of ["expanded", "provided"] as const) select(SOURCE_LABELS[mode], work.sourceMode === mode, () => {
        work.setSourceMode(mode);
        this.saveSourceMode();
      });
    }
    this.openMenu = { menu, button };
    button.setAttribute("aria-expanded", "true");
    menu.onHide(() => {
      if (this.openMenu?.menu !== menu) return;
      this.openMenu = null;
      button.setAttribute("aria-expanded", "false");
      this.root.ownerDocument.defaultView?.requestAnimationFrame(() => { if (!chosen) restoreFocus(); });
    });
    if (Platform.isAndroidApp && caret) {
      // Obsidian's mobile menu can extend beneath an open keyboard.
      this.root.querySelector<HTMLTextAreaElement>(caret.field)?.blur();
      button.focus({ preventScroll: true });
    }
    const anchor = button.getBoundingClientRect();
    menu.showAtPosition({ x: anchor.left, y: anchor.bottom });
  }
}
