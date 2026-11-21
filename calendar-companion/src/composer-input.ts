export function submitComposerShortcut(event: KeyboardEvent, input: HTMLTextAreaElement, composing: boolean, action: HTMLButtonElement | null): false | undefined {
  const ctrlOrCmd = event.ctrlKey !== event.metaKey;
  if (event.key !== "Enter" || !ctrlOrCmd || event.altKey || event.shiftKey) return;
  if (event.defaultPrevented || event.isComposing || composing || input.ownerDocument.activeElement !== input) return;
  if (!event.repeat && action && !action.disabled && !action.hidden) action.click();
  return false;
}

export function sizeComposerInput(input: HTMLTextAreaElement): void {
  const win = input.ownerDocument.defaultView;
  if (!win || !input.offsetWidth) return;
  const style = win.getComputedStyle(input);
  const lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight)) return;
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = input.offsetHeight - input.clientHeight;
  const min = Math.ceil(lineHeight * input.rows + padding + border);
  const max = Math.ceil(lineHeight * 3 + padding + border);
  const scroll = input.scrollTop;
  input.style.removeProperty("height");
  input.classList.remove("is-overflowing");
  const natural = input.scrollHeight + border;
  input.setCssProps({ height: `${Math.min(max, Math.max(min, natural))}px` });
  input.classList.toggle("is-overflowing", natural > max);
  if (natural > max) {
    input.scrollTop = input.ownerDocument.activeElement === input && input.selectionEnd === input.value.length ? input.scrollHeight : scroll;
  }
}
