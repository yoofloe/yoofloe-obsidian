import { Component, MarkdownRenderer, finishRenderMath, type App } from "obsidian";
import { safeNoteMarkdown } from "./note-context";

const PAGE_HEIGHT = 1600;
const MAX_PAGES = 10;
const CAPTURE_PROPERTIES = [
  "display", "color", "background-color", "font-family", "font-size", "font-weight", "font-style", "line-height",
  "white-space", "overflow-wrap", "word-break", "text-align", "text-decoration", "vertical-align",
  "padding", "margin", "border", "border-collapse", "border-spacing", "border-radius",
  "width", "height", "min-width", "max-width", "box-sizing", "flex", "flex-direction", "gap",
  "position", "top", "left", "bottom", "right", "list-style-type", "list-style-position",
  "fill", "stroke", "stroke-width", "transform", "transform-origin",
] as const;

function copyRenderedNode(element: Element, win: Window, root = false): Element {
  const clone = element.cloneNode(false) as HTMLElement | SVGElement;
  for (const attribute of Array.from(clone.attributes)) {
    if (/^on/i.test(attribute.name) || ["src", "srcset", "href", "xlink:href"].includes(attribute.name) && !attribute.value.startsWith("#"))
      clone.removeAttribute(attribute.name);
  }
  const style = win.getComputedStyle(element);
  for (const property of CAPTURE_PROPERTIES) {
    if (root && ["position", "top", "left", "bottom", "right", "margin"].includes(property)) continue;
    const value = style.getPropertyValue(property);
    // A self-contained image must not fetch fonts, backgrounds or other resources.
    if (value && !/url\s*\(/i.test(value)) clone.style.setProperty(property, value);
  }
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 3) clone.appendChild(child.cloneNode());
    else if (child instanceof element.ownerDocument.defaultView!.Element &&
      !["script", "style", "iframe", "object", "embed", "img", "image", "video", "audio", "link", "input", "button"].includes(child.tagName.toLowerCase()))
      clone.appendChild(copyRenderedNode(child, win));
  }
  return clone;
}

/** Render only sanitized selected Markdown; no screen, vault or network capture. */
export async function selectionImages(
  app: App, container: HTMLElement, text: string, path: string, current: () => boolean, maximumPages = MAX_PAGES,
): Promise<File[]> {
  const win = container.ownerDocument.defaultView;
  if (!win || !current()) throw Error("Image preparation was cancelled.");
  if (new TextEncoder().encode(text).length > 512 * 1024)
    throw Error("Choose a smaller passage to render as images. Long text can be attached as a reference.");
  const component = new Component();
  component.load();
  const surface = container.createDiv({ cls: "y-ai-reference-render" });
  const files: File[] = [];
  try {
    await MarkdownRenderer.render(app, safeNoteMarkdown(text), surface, path, component);
    if (surface.querySelector(".math, mjx-container")) await finishRenderMath();
    if (!current()) throw Error("Image preparation was cancelled.");
    const width = Math.max(800, Math.ceil(surface.scrollWidth));
    const height = Math.max(1, Math.ceil(surface.scrollHeight));
    const count = Math.ceil(height / PAGE_HEIGHT);
    if (width > 2048 || count > Math.min(MAX_PAGES, maximumPages))
      throw Error(`This selection needs ${count} image page(s) or a wider image. Select a smaller passage, or attach it as text.`);
    const rendered = copyRenderedNode(surface, win, true);
    rendered.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    rendered.removeAttribute("class");
    const html = new win.XMLSerializer().serializeToString(rendered);
    for (let page = 0; page < count; page++) {
      if (!current()) throw Error("Image preparation was cancelled.");
      const pageHeight = Math.min(PAGE_HEIGHT, height - page * PAGE_HEIGHT);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${pageHeight}"><foreignObject x="0" y="-${page * PAGE_HEIGHT}" width="${width}" height="${height}">${html}</foreignObject></svg>`;
      const image = container.ownerDocument.createElement("img");
      // A data URL keeps the SVG self-contained and the canvas readable in Chromium/WebView.
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      await image.decode();
      const canvas = container.ownerDocument.createElement("canvas");
      canvas.width = width; canvas.height = pageHeight;
      const context = canvas.getContext("2d");
      if (!context) throw Error("Image rendering is unavailable on this device.");
      context.fillStyle = win.getComputedStyle(surface).backgroundColor;
      context.fillRect(0, 0, width, pageHeight);
      context.drawImage(image, 0, 0);
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
      canvas.width = 1; canvas.height = 1;
      if (!blob || !current()) throw Error("Image preparation was cancelled or the image could not be encoded.");
      const title = path.split("/").at(-1)?.replace(/\.md$/i, "").slice(0, 100) ?? "Reference";
      files.push(new File([blob], `${title} - reference ${page + 1}.png`, { type: "image/png" }));
      // Background Electron and Android WebViews can suspend animation frames.
      if (page + 1 < count) await new Promise<void>(resolve => win.setTimeout(resolve, 0));
    }
    return files;
  } finally { component.unload(); surface.remove(); }
}
