import { Menu, setIcon } from "obsidian";
import { modelCatalog } from "./ai-models";
import type { AiModelOptions } from "./ai-session";
import { EFFORT_LABELS, resolveEffort, supportedEfforts, type EffortSetting } from "./effort";
import { supportsHostedTools } from "./research";
import type { AiWorkspace } from "./workspace";

const PICKER_LABEL = { model: "Model", effort: "Thinking depth" } as const;
type Picker = keyof typeof PICKER_LABEL;
const PROMPT_SELECTOR = ".y-ai-primary-prompt, .y-ai-follow-up-input";
type Caret = { field: ".y-ai-primary-prompt" | ".y-ai-follow-up-input"; from: number; to: number };

function selectedEffort(model: Readonly<AiModelOptions>): EffortSetting {
  return model.effort ?? resolveEffort(model.model) ?? "default";
}

export class ComposerModelControls {
  private openMenu: { menu: Menu; button: HTMLButtonElement } | null = null;

  constructor(private readonly root: HTMLElement, private readonly getWork: () => AiWorkspace,
    private readonly openSettings: () => void) {}

  render(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "y-ai-composer-models", attr: { role: "group", "aria-label": "Model options" } });
    for (const kind of ["model", "effort"] as const) {
      const button = group.createEl("button", { cls: "y-ai-model-picker", attr: {
        type: "button", "data-model-picker": kind, "aria-haspopup": "menu", "aria-expanded": "false",
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
    const values = { model: known?.label.split(" · ")[0] ?? (model.model ? `Custom · ${model.model}` : "Choose a model"),
      effort: EFFORT_LABELS[selectedEffort(model)] };
    const disabled = !work.current || work.settingsLocked || work.modelSaving;
    this.root.querySelectorAll<HTMLButtonElement>("[data-model-picker]").forEach(button => {
      const kind = button.dataset.modelPicker as Picker;
      const value = values[kind];
      const label = button.querySelector(".y-ai-picker-value");
      if (label?.textContent !== value) label?.setText(value);
      button.setAttribute("aria-label", `${PICKER_LABEL[kind]}: ${value}`);
      button.disabled = disabled;
    });
    if (disabled) this.close();
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
      const picker = this.root.querySelector<HTMLButtonElement>(`[data-model-picker="${kind}"]`);
      const input = caret && this.root.querySelector<HTMLTextAreaElement>(caret.field);
      const active = this.root.ownerDocument.activeElement;
      if (active && active !== this.root.ownerDocument.body && active !== button && active !== picker && active !== input) return;
      if (caret && input && !input.disabled) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(caret.from, caret.to);
      } else if (picker && !picker.disabled) picker.focus({ preventScroll: true });
    };
    const select = (label: string, current: boolean, options: AiModelOptions) => {
      menu.addItem(item => item.setTitle(label).setChecked(current).onClick(() => {
        chosen = true;
        this.close();
        if (current) restoreFocus();
        else void work.setModel(options).then(restoreFocus);
      }));
    };
    if (kind === "model") {
      const models = modelCatalog("openai").models;
      for (const model of models) select(model.label, work.model.model === model.id, { model: model.id });
      if (work.model.model && !models.some(model => model.id === work.model.model))
        select(`Custom · ${work.model.model}`, true, work.model);
      if (work.model.model && !supportsHostedTools(work.model.model))
        menu.addItem(item => item.setTitle("Hosted web, analysis and image tools unavailable").setDisabled(true));
      menu.addSeparator();
      menu.addItem(item => item.setTitle("Custom model…").onClick(() => {
        chosen = true;
        this.close();
        this.openSettings();
      }));
    } else {
      const selected = selectedEffort(work.model);
      const choices: EffortSetting[] = ["default", ...supportedEfforts(work.model.model)];
      for (const effort of choices) select(EFFORT_LABELS[effort], effort === selected, { ...work.model, effort });
    }
    this.openMenu = { menu, button };
    button.setAttribute("aria-expanded", "true");
    menu.onHide(() => {
      if (this.openMenu?.menu !== menu) return;
      this.openMenu = null;
      button.setAttribute("aria-expanded", "false");
      this.root.ownerDocument.defaultView?.requestAnimationFrame(() => { if (!chosen) restoreFocus(); });
    });
    const anchor = button.getBoundingClientRect();
    menu.showAtPosition({ x: anchor.left, y: anchor.bottom });
  }
}
