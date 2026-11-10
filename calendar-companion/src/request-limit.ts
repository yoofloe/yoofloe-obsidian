export type RequestLimit = number | "none";
export function requestLimit(value: unknown): RequestLimit {
  if (value === "none") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw Error("Choose a positive whole number or no request-count limit.");
}
export function customRequestLimit(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim()); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
export function requestLimitLabel(value: RequestLimit): string { return value === "none" ? "No request-count limit" : `${value} request(s) max`; }
