import { requestUrl } from "obsidian";
import { buildByokPrompt, getByokTaskDefinition } from "./prompts";
import type { YoofloeBundle, YoofloeByokSettings, YoofloeByokTaskType } from "../types";

type ByokRunOptions = {
  settings: YoofloeByokSettings;
  bundle: YoofloeBundle;
  taskType: YoofloeByokTaskType;
};

function extractTextFromGemini(payload: Record<string, unknown>) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
  const content = firstCandidate && typeof firstCandidate.content === "object"
    ? firstCandidate.content as Record<string, unknown>
    : undefined;
  const parts = Array.isArray(content?.parts) ? content?.parts as Array<Record<string, unknown>> : [];
  const text = parts
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Gemini returned no text output.");
  }

  return text;
}

function extractTextFromOpenAi(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output as Array<Record<string, unknown>> : [];
  const text = output.flatMap((item) => {
    const content = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
    return content
      .map((part) => {
        if (typeof part.text === "string" && (part.type === "output_text" || part.type === "text")) {
          return part.text;
        }
        return "";
      })
      .filter(Boolean);
  }).join("\n").trim();

  if (!text) {
    throw new Error("OpenAI returned no text output.");
  }

  return text;
}

function extractTextFromAnthropic(payload: Record<string, unknown>) {
  const content = Array.isArray(payload.content) ? payload.content as Array<Record<string, unknown>> : [];
  const text = content
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) {
    throw new Error("Anthropic returned no text output.");
  }

  return text;
}

function extractProviderError(provider: string, status: number, payload: unknown) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (provider === "gemini" && record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
    }

    if ((provider === "openai" || provider === "anthropic") && record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === "string" && error.message.trim()) {
        return error.message;
      }
    }
  }

  return `${provider} request failed with status ${status}.`;
}

function normalizeMarkdownBody(markdown: string) {
  let value = markdown.trim();

  if (value.startsWith("```")) {
    value = value.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }

  if (value.startsWith("# ")) {
    const firstLineBreak = value.indexOf("\n");
    value = firstLineBreak >= 0 ? value.slice(firstLineBreak + 1).trim() : "";
  }

  return value;
}

async function runGemini({ apiKey, model, prompt }: { apiKey: string; model: string; prompt: string; }) {
  const response = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    })
  });

  if (response.status >= 400) {
    throw new Error(extractProviderError("gemini", response.status, response.json));
  }

  return normalizeMarkdownBody(extractTextFromGemini((response.json || {}) as Record<string, unknown>));
}

async function runOpenAi({
  apiKey,
  model,
  prompt,
  systemPrompt
}: {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt: string;
}) {
  const response = await requestUrl({
    url: "https://api.openai.com/v1/responses",
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: prompt
    })
  });

  if (response.status >= 400) {
    throw new Error(extractProviderError("openai", response.status, response.json));
  }

  return normalizeMarkdownBody(extractTextFromOpenAi((response.json || {}) as Record<string, unknown>));
}

async function runAnthropic({
  apiKey,
  model,
  prompt,
  systemPrompt
}: {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt: string;
}) {
  const response = await requestUrl({
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: 1600,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (response.status >= 400) {
    throw new Error(extractProviderError("anthropic", response.status, response.json));
  }

  return normalizeMarkdownBody(extractTextFromAnthropic((response.json || {}) as Record<string, unknown>));
}

export async function runByokAnalysis({ settings, bundle, taskType }: ByokRunOptions) {
  const provider = settings.type;

  if (provider === "none") {
    throw new Error("Select an AI provider in Settings > Yoofloe before running AI commands.");
  }

  const apiKey = settings.apiKey.trim();
  if (!apiKey) {
    throw new Error(`Add your ${provider} API key in Settings > Yoofloe before running AI commands.`);
  }

  const model = settings.model.trim();
  if (!model) {
    throw new Error(`Add a ${provider} model ID in Settings > Yoofloe before running AI commands.`);
  }

  const task = getByokTaskDefinition(taskType);
  const prompt = buildByokPrompt({ bundle, taskType });

  switch (provider) {
    case "gemini":
      return await runGemini({ apiKey, model, prompt: `${task.systemPrompt}\n\n${prompt}` });
    case "openai":
      return await runOpenAi({ apiKey, model, prompt, systemPrompt: task.systemPrompt });
    case "anthropic":
      return await runAnthropic({ apiKey, model, prompt, systemPrompt: task.systemPrompt });
    default:
      throw new Error("Unsupported BYOK provider.");
  }
}
