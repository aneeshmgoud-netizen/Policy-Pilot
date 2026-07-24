import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { buildMessagesV3, PROMPT_VERSION } from './prompts/v3.prompt';
import {
  Recommendation,
  RecommendationInput,
  RecommendationResult,
  RecommendationSchema,
  TokenUsage,
} from './agent.types';

export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
export const MAX_ATTEMPTS = 3;

// USD per 1M tokens. gpt-4o-mini list pricing at time of writing; used only to
// estimate and record cost for telemetry/evaluation, not for billing.
const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
};

// Minimal shape of the OpenAI chat client the agent depends on. Declaring it
// explicitly lets tests inject a mock without the real SDK, and keeps the
// service decoupled from the full OpenAI surface.
export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string | null } }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null;
}

export interface ChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        response_format: { type: 'json_object' };
        temperature?: number;
      }): Promise<ChatCompletionResponse>;
    };
  };
}

export interface AgentConfig {
  apiKey?: string;
  model?: string;
}

/** Thrown when the model cannot produce schema-valid output within MAX_ATTEMPTS. */
export class RecommendationValidationError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'RecommendationValidationError';
  }
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly apiKey?: string;
  readonly model: string;
  private client?: ChatClient;

  constructor(config: AgentConfig = {}, client?: ChatClient) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_CHAT_MODEL;
    // Injected client (tests) wins; otherwise the real client is created lazily
    // on first use so the module boots without an API key.
    this.client = client;
  }

  /**
   * Produce a validated, policy-grounded recommendation for a request. Retries
   * up to MAX_ATTEMPTS when the model returns non-JSON or schema-invalid output,
   * logging each failure as a warning. Throws RecommendationValidationError if
   * all attempts fail.
   */
  async recommend(input: RecommendationInput): Promise<RecommendationResult> {
    const messages = buildMessagesV3(input);
    let lastError = '';

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const startedAt = Date.now();
      const response = await this.getClient().chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0,
      });
      const latencyMs = Date.now() - startedAt;

      const content = response.choices[0]?.message?.content ?? '';
      const parsed = this.parseAndValidate(content);

      if (parsed.ok) {
        const usage = this.computeUsage(response, latencyMs);
        // Local observability line: every successful call's cost/latency/token
        // footprint, independent of the AI_RECOMMENDED audit record the worker
        // writes to Postgres — useful when tailing logs during development.
        this.logger.log(
          `[LLM Execution] Latency: ${usage.latencyMs}ms, ` +
            `Cost: $${usage.estimatedCostUsd.toFixed(6)}, Tokens: ${usage.totalTokens}`,
        );
        return {
          recommendation: parsed.value,
          modelName: this.model,
          promptVersion: PROMPT_VERSION,
          rawResponse: parsed.raw,
          attemptNumber: attempt,
          usage,
        };
      }

      lastError = parsed.error;
      // Log validation failures as warnings, per the retry contract.
      this.logger.warn(
        `Recommendation output invalid on attempt ${attempt}/${MAX_ATTEMPTS} ` +
          `for request ${input.accessRequest.requestId}: ${parsed.error}`,
      );
    }

    throw new RecommendationValidationError(
      `Model failed to produce schema-valid output after ${MAX_ATTEMPTS} attempts: ${lastError}`,
      MAX_ATTEMPTS,
    );
  }

  private parseAndValidate(
    content: string,
  ):
    | { ok: true; value: Recommendation; raw: unknown }
    | { ok: false; error: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return { ok: false, error: 'response was not valid JSON' };
    }

    const result = RecommendationSchema.safeParse(raw);
    if (!result.success) {
      return {
        ok: false,
        error: `schema validation failed: ${result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      };
    }

    return { ok: true, value: result.data, raw };
  }

  private computeUsage(
    response: ChatCompletionResponse,
    latencyMs: number,
  ): TokenUsage {
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens =
      response.usage?.total_tokens ?? promptTokens + completionTokens;
    const pricing = MODEL_PRICING[this.model];
    const estimatedCostUsd = pricing
      ? (promptTokens / 1_000_000) * pricing.inputPer1M +
        (completionTokens / 1_000_000) * pricing.outputPer1M
      : 0;
    return { promptTokens, completionTokens, totalTokens, estimatedCostUsd, latencyMs };
  }

  private getClient(): ChatClient {
    if (!this.client) {
      if (!this.apiKey) {
        throw new Error(
          'OPENAI_API_KEY is not configured — set it in backend/.env before generating recommendations.',
        );
      }
      this.client = new OpenAI({ apiKey: this.apiKey }) as unknown as ChatClient;
    }
    return this.client;
  }
}
