import { requestUrl } from "obsidian";
import { buildAiDocumentPrompt, getAiDocumentDefinition } from "./prompts";
import type { YoofloeAiDocumentType, YoofloeBundle, YoofloeByokSettings } from "../types";

type AiDocumentRunOptions = {
  settings: YoofloeByokSettings;
  googleAccessToken: string | null;
  bundle: YoofloeBundle;
  documentType: YoofloeAiDocumentType;
  gardenerBrief?: string | null;
  focusInstruction?: string | null;
};

function extractTextFromGemini(payload: Record<string, unknown>) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const firstCandidate = candidates[0] as Record<string, unknown> | undefined;
  const content = firstCandidate && typeof firstCandidate.content === "object"
    ? firstCandidate.content as Record<string, unknown>
    : undefined;
  const parts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];
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

function extractProviderError(provider: string, status: number, payload: unknown) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;

    if (record.error && typeof record.error === "object") {
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

function providerLabel(provider: YoofloeByokSettings["type"]) {
  switch (provider) {
    case "gemini-google":
      return "Gemini (Google AI)";
    case "gemini-vertex":
      return "Gemini (Vertex AI)";
    default:
      return "AI provider";
  }
}

async function runGeminiGoogle({
  accessToken,
  projectId,
  model,
  prompt
}: {
  accessToken: string;
  projectId: string;
  model: string;
  prompt: string;
}) {
  const response = await requestUrl({
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-goog-user-project": projectId
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
    throw new Error(extractProviderError("gemini-google", response.status, response.json));
  }

  return normalizeMarkdownBody(extractTextFromGemini((response.json || {}) as Record<string, unknown>));
}

async function runGeminiVertex({
  accessToken,
  projectId,
  location,
  model,
  prompt
}: {
  accessToken: string;
  projectId: string;
  location: string;
  model: string;
  prompt: string;
}) {
  const response = await requestUrl({
    url: `https://${encodeURIComponent(location)}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
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
    throw new Error(extractProviderError("gemini-vertex", response.status, response.json));
  }

  return normalizeMarkdownBody(extractTextFromGemini((response.json || {}) as Record<string, unknown>));
}

export async function runAiDocumentAnalysis({
  settings,
  googleAccessToken,
  bundle,
  documentType,
  gardenerBrief,
  focusInstruction
}: AiDocumentRunOptions) {
  const provider = settings.type;
  const providerName = providerLabel(provider);

  if (provider === "none") {
    throw new Error("Select an AI provider in Settings > Yoofloe before running AI document commands.");
  }

  const document = getAiDocumentDefinition(documentType);
  const prompt = buildAiDocumentPrompt({ bundle, documentType, gardenerBrief, focusInstruction });

  if (provider === "gemini-google" || provider === "gemini-vertex") {
    const normalizedAccessToken = googleAccessToken?.trim() ?? "";
    if (!normalizedAccessToken) {
      throw new Error("Connect Google in Settings > Yoofloe before running Gemini commands.");
    }

    const projectId = settings.project.trim();
    if (!projectId) {
      throw new Error(`Add your Google Cloud Project ID in Settings > Yoofloe before running ${providerName} commands.`);
    }

    if (provider === "gemini-google") {
      const model = settings.googleModel.trim();
      if (!model) {
        throw new Error("Add a Gemini model ID in Settings > Yoofloe before running Gemini commands.");
      }

      return await runGeminiGoogle({
        accessToken: normalizedAccessToken,
        projectId,
        model,
        prompt: `${document.systemPrompt}\n\n${prompt}`
      });
    }

    const model = settings.vertexModel.trim();
    if (!model) {
      throw new Error("Add a Vertex model ID in Settings > Yoofloe before running Vertex AI commands.");
    }

    const location = settings.location.trim() || "us-central1";
    return await runGeminiVertex({
      accessToken: normalizedAccessToken,
      projectId,
      location,
      model,
      prompt: `${document.systemPrompt}\n\n${prompt}`
    });
  }

  throw new Error(`Unsupported AI provider: ${providerName}.`);
}
