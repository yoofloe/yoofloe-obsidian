import { vaultPath } from "./agent-policy";

export const MAX_GENERATED_BYTES = 12 * 1024 * 1024;
export const GENERATED_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "pdf", "csv", "txt", "json"] as const;
export interface PendingGeneratedFile { origin: string; name: string; base64?: string; container?: string; file?: string }
export interface GeneratedFile { id: string; name: string; extension: string; bytes: number; sha256: string }
export interface GeneratedStore {
  stage(files: PendingGeneratedFile[], key: string, current: () => boolean, byteBudget?: number): Promise<GeneratedFile[]>;
}
export function generatedExtension(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!(GENERATED_EXTENSIONS as readonly string[]).includes(extension)) throw Error("This generated file type cannot be saved here. Use PNG, JPEG, WebP, PDF, CSV, TXT or JSON.");
  return extension;
}
export function generatedPath(path: string): string {
  vaultPath(path, true); generatedExtension(path);
  if (["[", "]", "#"].some(char => path.includes(char))) throw Error("Choose a generated-file path without brackets or #.");
  return path;
}
export function generatedCachePath(configDir: string, file: GeneratedFile): string {
  if (!/^[0-9a-f-]{36}$/.test(file.id) || generatedExtension("file." + file.extension) !== file.extension) throw Error("Invalid generated-file reference.");
  return `${configDir}/plugins/yoofloe/generated/${file.id}.${file.extension}`;
}
export async function binaryDigest(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export function validateGeneratedBytes(buffer: ArrayBuffer, extension: string): void {
  if (!buffer.byteLength || buffer.byteLength > MAX_GENERATED_BYTES) throw Error("The generated file is empty or larger than the 12 MiB device limit. Other results are kept.");
  const b = new Uint8Array(buffer), ascii = (n: number) => String.fromCharCode(...b.slice(0, n));
  const valid = extension === "png" ? [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v)
    : ["jpg", "jpeg"].includes(extension) ? b[0] === 255 && b[1] === 216 && b[2] === 255
    : extension === "webp" ? ascii(4) === "RIFF" && String.fromCharCode(...b.slice(8,12)) === "WEBP"
    : extension === "pdf" ? ascii(5) === "%PDF-" : ["csv", "txt", "json"].includes(extension);
  if (!valid) throw Error("The generated file did not match its declared type.");
  if (["csv", "txt", "json"].includes(extension)) { const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); if (text.includes("\0")) throw Error("This text file contains binary data."); }
}
export function readGeneratedFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 2048) throw Error("This saved generated-file record exceeds its metadata limit. The original archive is kept.");
  return value.filter((file): file is GeneratedFile => {
    if (!file || typeof file !== "object") return false; const f = file as Record<string, unknown>;
    return typeof f.id === "string" && /^[0-9a-f-]{36}$/.test(f.id) && typeof f.name === "string" && f.name.length <= 180 && !/[\\/]/.test(f.name) && ![...f.name].some(c => c.charCodeAt(0) < 32) && typeof f.extension === "string" && (GENERATED_EXTENSIONS as readonly string[]).includes(f.extension) && typeof f.bytes === "number" && Number.isSafeInteger(f.bytes) && f.bytes > 0 && f.bytes <= MAX_GENERATED_BYTES && typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256);
  }).map(f => ({ id:f.id, name:f.name, extension:f.extension, bytes:f.bytes, sha256:f.sha256 }));
}

/** The cache stores returned work only. It never reads a note or exposes the key in a URL. */
export function generatedStore(options: {
  configDir: string; exists(path: string): Promise<boolean>; mkdir(path: string): Promise<void>;
  write(path: string, bytes: ArrayBuffer): Promise<void>; read(path: string): Promise<ArrayBuffer>;
  download(container: string, file: string, key: string, current: () => boolean, byteBudget?: number): Promise<ArrayBuffer>;
}): GeneratedStore {
  const saved = new Map<string, GeneratedFile>();
  return { async stage(files, key, current, byteBudget = 32 * 1024 * 1024) {
    const result: GeneratedFile[] = []; let total = 0;
    for (const input of files.slice(0, 16)) {
      if (!current()) throw Error("Stopped before retrieving generated files.");
      const prior = saved.get(input.origin); if (prior) { result.push(prior); continue; }
      const remaining = Math.min(MAX_GENERATED_BYTES, byteBudget - total); if (remaining < 1) throw Error("This step reached its generated-file size budget. Earlier files are kept.");
      const name = input.name.split(/[\\/]/).at(-1)?.split("").filter(c => c.charCodeAt(0) >= 32).join("").slice(0, 180) ?? "", extension = generatedExtension(name);
      let bytes: ArrayBuffer;
      if (input.base64 !== undefined) {
        if (input.base64.length > Math.ceil(remaining * 4 / 3) + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw Error("The generated image exceeds its device limit or is invalid.");
        const raw = atob(input.base64), decoded = new Uint8Array(raw.length); for (let i=0;i<raw.length;i++) decoded[i]=raw.charCodeAt(i); bytes=decoded.buffer;
      } else {
        if (!/^cntr_[A-Za-z0-9_-]{1,150}$/.test(input.container ?? "") || !/^cfile_[A-Za-z0-9_-]{1,150}$/.test(input.file ?? "")) throw Error("Invalid generated download reference.");
        bytes = await options.download(input.container!, input.file!, key, current, remaining);
      }
      if (!current()) throw Error("Stopped before caching the generated file.");
      validateGeneratedBytes(bytes, extension); total += bytes.byteLength;
      if (total > byteBudget) throw Error("Generated files exceeded this step's device memory budget. Earlier files are kept.");
      const file: GeneratedFile = { id: crypto.randomUUID(), name, extension, bytes: bytes.byteLength, sha256: await binaryDigest(bytes) };
      const root = `${options.configDir}/plugins/yoofloe/generated`; if (!await options.exists(root)) await options.mkdir(root);
      if (!current()) throw Error("Stopped before caching the generated file.");
      const path = generatedCachePath(options.configDir, file); await options.write(path, bytes);
      if (await binaryDigest(await options.read(path)) !== file.sha256) throw Error("The generated file could not be preserved locally.");
      saved.set(input.origin, file); result.push(file);
    }
    return result;
  } };
}
