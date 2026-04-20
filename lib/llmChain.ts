import OpenAI from "openai";
import {
  getGlmCodingClient,
  getGlmPaasClient,
  isGlmConfigured,
} from "./glm";

export class LlmRateLimitError extends Error {
  retryAfterMs?: number;

  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "LlmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Model identifiers for the fallback chain
 */
export type ModelId = "glm-4.7-flash";

/**
 * Provider group type
 */
export type ProviderGroup = "zai";

/**
 * Model to provider group mapping
 */
const MODEL_GROUPS: Record<ModelId, ProviderGroup> = {
  "glm-4.7-flash": "zai",
};

/**
 * Model information type
 */
export interface ModelInfo {
  id: ModelId;
  name: string;
  available: boolean;
  group: ProviderGroup;
}

/**
 * Response from the LLM call
 */
export interface LlmResponse {
  response: string;
  modelUsed: ModelId;
  tokensUsed?: number;
}

/**
 * Options for the LLM call
 */
export interface LlmCallOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  preferredModel?: ModelId;
  userId?: string;
  onChunk?: (text: string) => void;
}

function parseRetryAfterMs(errorMessage: string): number | undefined {
  const secondsMatch = errorMessage.match(/retry after[:\s]+(\d+)\s*s/i);
  if (secondsMatch) {
    return Number(secondsMatch[1]) * 1000;
  }

  const millisecondsMatch = errorMessage.match(/retry after[:\s]+(\d+)\s*ms/i);
  if (millisecondsMatch) {
    return Number(millisecondsMatch[1]);
  }

  return undefined;
}

function isRateLimitError(error: unknown): boolean {
  const errorMessage =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  return (
    errorMessage.includes("429") ||
    errorMessage.includes("rate limit") ||
    errorMessage.includes("too many requests")
  );
}

/**
 * Gets all models and their availability status for a specific user.
 *
 * @param userId - The user's ID to check their configured API keys
 * @returns Promise<ModelInfo[]> - Array of model info with availability
 */
export async function getAvailableModels(userId: string): Promise<ModelInfo[]> {
  const glmAvailable = await isGlmConfigured(userId);

  return [
    { id: "glm-4.7-flash", name: "GLM-4.7-Flash", available: glmAvailable, group: "zai" as ProviderGroup },
  ];
}

/**
 * Calls an LLM with automatic fallback to other models if primary fails.
 *
 * @param prompt - The user prompt to send
 * @param options - Optional configuration for the call (must include userId)
 * @returns Promise<LlmResponse> - The response and model used
 * @throws Error if all models fail or userId is not provided
 */
export async function callWithFallback(
  prompt: string,
  options: LlmCallOptions = {}
): Promise<LlmResponse> {
  const { maxTokens = 4096, temperature = 0.7, systemPrompt, userId } = options;

  if (!userId) {
    throw new Error("userId is required for LLM calls");
  }

  const errors: { model: ModelId; error: string }[] = [];
  let sawRateLimit = false;
  let retryAfterMs: number | undefined;

  // Build the model order - only GLM-4.7-Flash available
  const preferredModel = options.preferredModel || "glm-4.7-flash";
  const group = MODEL_GROUPS[preferredModel];

  // Get all models in the same group for fallback
  const groupModels = Object.entries(MODEL_GROUPS)
    .filter(([, g]) => g === group)
    .map(([id]) => id as ModelId);

  // Build order: preferred first, then other models in same group
  const modelOrder: ModelId[] = [
    preferredModel,
    ...groupModels.filter((m) => m !== preferredModel),
  ];

  // Try each model in order
  for (const modelId of modelOrder) {
    try {
      const result = await callModel(modelId, prompt, {
        maxTokens,
        temperature,
        systemPrompt,
        userId,
        onChunk: options.onChunk,
      });
      if (result) {
        return result;
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      if (isRateLimitError(error)) {
        sawRateLimit = true;
        retryAfterMs ??= parseRetryAfterMs(errorMessage);
        console.warn(`Model ${modelId} hit a rate limit:`, errorMessage);
      } else {
        console.warn(`Model ${modelId} failed:`, errorMessage);
      }

      errors.push({ model: modelId, error: errorMessage });
    }
  }

  if (sawRateLimit) {
    throw new LlmRateLimitError(
      "The AI provider is temporarily rate-limiting requests. Please wait a moment and try again.",
      retryAfterMs
    );
  }

  // All models failed
  throw new Error(
    `All models failed. Errors: ${errors
      .map((e) => `${e.model}: ${e.error}`)
      .join("; ")}`
  );
}

/**
 * Calls a specific model.
 * Returns null if model is not configured.
 */
async function callModel(
  modelId: ModelId,
  prompt: string,
  options: { maxTokens: number; temperature: number; systemPrompt?: string; userId: string; onChunk?: (text: string) => void }
): Promise<LlmResponse | null> {
  switch (modelId) {
    case "glm-4.7-flash":
      return callGlm(prompt, options);
    default:
      return null;
  }
}

/**
 * Call GLM-4.7-Flash
 * Tries Coding Subscription first (Anthropic format), falls back to PAAS (OpenAI format)
 */
async function callGlm(
  prompt: string,
  options: { maxTokens: number; temperature: number; systemPrompt?: string; userId: string; onChunk?: (text: string) => void }
): Promise<LlmResponse | null> {
  const apiModelName = "glm-4.7-flash";
  const endpointErrors: string[] = [];

  // Try Coding Subscription first (uses Anthropic format)
  try {
    const codingClient = await getGlmCodingClient(options.userId);
    if (codingClient) {
      const stream = await codingClient.messages.create({
        model: apiModelName,
        max_tokens: options.maxTokens,
        system: options.systemPrompt,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      });

      let fullText = "";
      for await (const chunk of stream) {
        if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
          const textChunk = chunk.delta.text || "";
          if (textChunk) {
            fullText += textChunk;
            if (options.onChunk) options.onChunk(textChunk);
          }
        }
      }

      if (fullText) {
        return {
          response: fullText,
          modelUsed: "glm-4.7-flash",
          tokensUsed: 0,
        };
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    endpointErrors.push(`coding endpoint: ${errorMessage}`);
    console.warn("GLM Coding Subscription failed, trying PAAS:", errorMessage);
  }

  // Fallback to PAAS API (uses OpenAI format)
  const paasClient = await getGlmPaasClient(options.userId);
  if (!paasClient) return null;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (options.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  try {
    const completion = await paasClient.chat.completions.create({
      model: apiModelName,
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullText = "";
    let finalUsage = 0;
    for await (const chunk of completion) {
      if (chunk.usage) {
        finalUsage = chunk.usage.total_tokens;
      }
      const content = chunk.choices[0]?.delta?.content || "";
      if (content) {
        fullText += content;
        if (options.onChunk) options.onChunk(content);
      }
    }

    if (!fullText) {
      throw new Error("No content in GLM response");
    }

    return {
      response: fullText,
      modelUsed: "glm-4.7-flash",
      tokensUsed: finalUsage,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    endpointErrors.push(`paas endpoint: ${errorMessage}`);

    if (endpointErrors.some((endpointError) => isRateLimitError(endpointError))) {
      throw new LlmRateLimitError(
        `GLM is rate-limited right now. ${endpointErrors.join("; ")}`,
        parseRetryAfterMs(errorMessage)
      );
    }

    throw new Error(`GLM request failed. ${endpointErrors.join("; ")}`);
  }
}
