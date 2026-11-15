import type { AiTransport } from "./ai-session";
import { findOpenAiModel } from "./openai-models";
import { openAiTransportFailure } from "./openai-request";

export interface InputBudget {
  estimated: number;
  exact?: number;
  inputLimit: number | null;
  bytes: number;
  hasFiles: boolean;
  hasCompaction: boolean;
  checked: boolean;
}

// Official model pages verified on 2026-11-15. Reserve the full supported output
// allowance (including reasoning) and a margin for service formatting.
const CONTEXT_WINDOW = 1050000;
const OUTPUT_RESERVE = 128000;
const FORMAT_RESERVE = 8192;
export const TOKEN_COUNT_THRESHOLD = 24000;
export class InputBudgetError extends Error {}

function inputKinds(value: unknown, found = { files: false, compaction: false }): typeof found {
  if (Array.isArray(value)) {
    for (const child of value) inputKinds(child, found);
  } else if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (item.type === "input_image" || item.type === "input_file") found.files = true;
    if (item.type === "compaction") found.compaction = true;
    if (item.content) inputKinds(item.content, found);
  }
  return found;
}

/** A local estimate for display. Admission uses the byte bound or provider count. */
export function estimateInput(body: Record<string, unknown>, encoded = JSON.stringify(body), bytes = new TextEncoder().encode(encoded).length): InputBudget {
  let ascii = 0, other = 0;
  for (const character of encoded) {
    if (character.codePointAt(0)! < 128) ascii++;
    else other += character.length;
  }
  const kinds = inputKinds(body.input);
  const known = typeof body.model === "string" && (findOpenAiModel(body.model) || body.model === "gpt-6-sol");
  return {
    estimated: Math.ceil(ascii / 3.5 + other * 1.5),
    inputLimit: known ? CONTEXT_WINDOW - OUTPUT_RESERVE - FORMAT_RESERVE : null,
    bytes, hasFiles: kinds.files, hasCompaction: kinds.compaction, checked: false,
  };
}

export function budgetLabel(budget: InputBudget): string {
  const number = (budget.exact ?? budget.estimated).toLocaleString();
  return budget.exact === undefined ? `~${number} tokens${budget.hasFiles || budget.hasCompaction ? " + attachments/context" : ""}` : `${number} input tokens`;
}

export async function verifyInputBudget(
  body: Record<string, unknown>, key: string, current: () => boolean, transport?: AiTransport, budget = estimateInput(body),
): Promise<InputBudget> {
  if (!current()) throw new InputBudgetError("Stopped before checking the next request.");
  const needsCount = budget.estimated >= TOKEN_COUNT_THRESHOLD || budget.hasFiles || budget.hasCompaction;
  if (!needsCount || !transport) {
    if (budget.inputLimit !== null && budget.bytes > budget.inputLimit)
      throw new InputBudgetError("This input may exceed the model's context window. Use a smaller reference or start a focused follow-up.");
    return budget;
  }
  // The count endpoint accepts the model input and tool schemas, not transport
  // options such as stream/store or an output generation budget.
  const countBody: Record<string, unknown> = {};
  for (const field of ["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "text", "reasoning"])
    if (body[field] !== undefined) countBody[field] = body[field];
  let response;
  try {
    response = await transport({
      url: "https://api.openai.com/v1/responses/input_tokens", method: "POST", contentType: "application/json",
      headers: { Authorization: "Bearer " + key }, body: JSON.stringify(countBody), throw: false,
    });
  } catch (error) {
    throw new InputBudgetError(`Input-size verification ${openAiTransportFailure(error)}. Your draft and completed work are kept.`);
  }
  if (!current()) throw new InputBudgetError("Stopped after the input check. No next model request was sent.");
  if (response.status < 200 || response.status >= 300)
    throw new InputBudgetError(`OpenAI input-size verification returned HTTP ${response.status}. Review the attachments or try again when the connection is available.`);
  if (response.text.length > 16384) throw new InputBudgetError("OpenAI returned an oversized token-count response.");
  let value: unknown;
  try { value = JSON.parse(response.text); } catch { throw new InputBudgetError("OpenAI returned an unreadable input token count."); }
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (result.object !== "response.input_tokens" || typeof result.input_tokens !== "number" || !Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0)
    throw new InputBudgetError("OpenAI did not confirm the input token count.");
  budget.exact = result.input_tokens; budget.checked = true;
  if (budget.inputLimit !== null && budget.exact > budget.inputLimit)
    throw new InputBudgetError(`This request needs ${budget.exact.toLocaleString()} input tokens. The input budget is ${budget.inputLimit.toLocaleString()} after reserving output space. Use fewer attachments or a smaller reference.`);
  return budget;
}
