export function requestUrl(options: unknown) {
  return (globalThis as unknown as { obsidianRequest: (options: unknown) => Promise<unknown> }).obsidianRequest(options);
}
