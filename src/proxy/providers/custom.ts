import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";

interface CustomTokens {
  base_url?: string;
  api_key?: string;
}

/**
 * Custom Provider — generic OpenAI-compatible proxy
 *
 * Each account stores: { base_url, api_key } in tokens field.
 * Models are fetched from the provider's /v1/models endpoint.
 * Supports any OpenAI-compatible API (DashScope, OpenRouter, etc.)
 */
export class CustomProvider extends BaseProvider {
  name = "custom";

  // Custom providers have dynamic models — loaded from DB
  supportedModels: ModelInfo[] = [];

  private getTokens(account: Account): CustomTokens | null {
    if (!account.tokens) return null;
    try {
      const t = typeof account.tokens === "string"
        ? JSON.parse(account.tokens)
        : account.tokens;
      return t as CustomTokens;
    } catch {
      return null;
    }
  }

  private getBaseUrl(account: Account): string | null {
    const tokens = this.getTokens(account);
    return tokens?.base_url || null;
  }

  private getApiKey(account: Account): string | null {
    const tokens = this.getTokens(account);
    return tokens?.api_key || null;
  }

  // ─── Model Loading from DB ───────────────────────────────────────────

  /** Load all custom models from DB accounts */
  async loadModelsFromDB(): Promise<ModelInfo[]> {
    try {
      const { db } = await import("../../db/index");
      const { accounts } = await import("../../db/schema");
      const { eq } = await import("drizzle-orm");

      const rows = await db.select().from(accounts).where(eq(accounts.provider, "custom"));
      const models: ModelInfo[] = [];

      for (const row of rows) {
        if (!row.enabled || row.status !== "active") continue;
        const tokens = row.tokens && typeof row.tokens === "object" ? row.tokens as Record<string, any> : {};
        const providerModels = tokens.models || [];

        for (const modelId of providerModels) {
          models.push({
            id: `c${row.id}-${modelId}`,
            object: "model",
            created: Date.now(),
            owned_by: "custom",
            tier: "standard",
            context_window: 128000,
            max_output: 16384,
            thinking: false,
            vision: false,
            creditUnit: "token",
            creditRate: 0.000001,
            creditSource: "estimated",
          });
        }
      }

      return models;
    } catch {
      return [];
    }
  }

  // ─── Model Fetching ──────────────────────────────────────────────────

  /** Fetch models from provider's /v1/models endpoint */
  async fetchModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
    try {
      const response = await this.fetchWithTimeout(
        `${baseUrl}/models`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        },
        15000
      );
      if (!response.ok) return [];
      const data = await response.json() as any;
      const models = data.data || data.models || [];
      return models.map((m: any) => ({
        id: m.id,
        object: "model" as const,
        created: m.created || Date.now(),
        owned_by: "custom",
        tier: "standard" as const,
        context_window: m.context_length || m.context_window || 128000,
        max_output: m.max_output || m.max_tokens || 16384,
        thinking: m.thinking ?? false,
        vision: m.vision ?? false,
        creditUnit: "token" as const,
        creditRate: 0.000001,
        creditSource: "estimated" as const,
      }));
    } catch {
      return [];
    }
  }

  // ─── Provider Interface ───────────────────────────────────────────────

  /** Extract account ID from model name (format: "c{Id}-{model}") */
  private extractAccountId(model: string): number | null {
    const match = model.match(/^c(\d+)-/);
    return match ? parseInt(match[1]) : null;
  }

  /** Get the actual upstream model name (strip account prefix) */
  private getUpstreamModel(model: string): string {
    return model.replace(/^c\d+-/, "");
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    // If model has account prefix, load that specific account
    const targetAccountId = this.extractAccountId(request.model);
    let baseUrl = this.getBaseUrl(account);
    let apiKey = this.getApiKey(account);
    if (targetAccountId) {
      // Will be resolved by router — account is already the right one
    }
    const upstreamModel = this.getUpstreamModel(request.model);
    if (!baseUrl || !apiKey) return { success: false, error: "Missing base_url or api_key" };

    const body: any = {
      model: upstreamModel,
      messages: request.messages,
      stream: false,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    try {
      const response = await this.fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        config.providerRequestTimeoutMs
      );

      if (response.status === 401 || response.status === 403) {
        const text = await response.text();
        if (text.includes("exhausted") || text.includes("quota") || text.includes("FreeTierOnly")) {
          return { success: false, error: `Quota exhausted: ${text.slice(0, 200)}`, quotaExhausted: true };
        }
        return { success: false, error: `Auth error (${response.status}): ${text.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Error (${response.status}): ${text.slice(0, 300)}` };
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices returned" };

      const resp: ChatCompletionResponse = {
        id: data.id || this.generateId(),
        object: "chat.completion",
        created: data.created || Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: choice.message?.content || "",
            ...(choice.message?.reasoning_content ? { reasoning_content: choice.message.reasoning_content } as any : {}),
          },
          finish_reason: choice.finish_reason || "stop",
        }],
        usage: {
          prompt_tokens: data.usage?.prompt_tokens || 0,
          completion_tokens: data.usage?.completion_tokens || 0,
          total_tokens: data.usage?.total_tokens || 0,
        },
      };

      const totalTokens = resp.usage.total_tokens;
      return {
        success: true,
        response: resp,
        tokensUsed: totalTokens,
        promptTokens: resp.usage.prompt_tokens,
        completionTokens: resp.usage.completion_tokens,
        creditsUsed: totalTokens * this.getProviderCreditRate(request.model),
        creditSource: "estimated",
      };
    } catch (error) {
      return { success: false, error: `Failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const baseUrl = this.getBaseUrl(account);
    const apiKey = this.getApiKey(account);
    if (!baseUrl || !apiKey) return { success: false, error: "Missing base_url or api_key" };

    const upstreamModel = this.getUpstreamModel(request.model);
    const body: any = {
      model: upstreamModel,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.top_p !== undefined) body.top_p = request.top_p;

    try {
      const response = await this.fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        config.providerRequestTimeoutMs
      );

      if (response.status === 401 || response.status === 403) {
        const text = await response.text();
        if (text.includes("exhausted") || text.includes("quota") || text.includes("FreeTierOnly")) {
          return { success: false, error: `Quota exhausted: ${text.slice(0, 200)}`, quotaExhausted: true };
        }
        return { success: false, error: `Auth error (${response.status}): ${text.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Error (${response.status}): ${text.slice(0, 300)}` };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Custom providers use API keys, no refresh needed" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!(this.getBaseUrl(account) && this.getApiKey(account));
  }

  async fetchQuota(): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    return { success: true, quota: { limit: 999999, remaining: 999999, used: 0, resetAt: null } };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const baseUrl = this.getBaseUrl(account);
    const apiKey = this.getApiKey(account);
    if (!baseUrl || !apiKey) return { kind: "missing_tokens", success: false, error: "Missing base_url or api_key" };

    try {
      // Test with a tiny request (use first available model)
      const tokens = this.getTokens(account);
      const testModel = (tokens?.models as string[])?.[0] || "gpt-3.5-turbo";
      const response = await this.fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: testModel,
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
        },
        config.providerQuotaTimeoutMs
      );

      if (response.status === 401 || response.status === 403) {
        const text = await response.text();
        if (text.includes("exhausted") || text.includes("quota")) {
          return { kind: "exhausted", success: false, error: "Quota exhausted" };
        }
        return { kind: "auth_error", success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }
      if (!response.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `HTTP ${response.status}` };
      }

      return {
        kind: "healthy",
        success: true,
        quota: { limit: 999999, remaining: 999999, used: 0, source: "custom.healthCheck" },
      };
    } catch (error) {
      return { kind: "transient_error", success: false, retryable: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ─── Stream Response ──────────────────────────────────────────────────

  private createStreamResponse(response: Response, model: string): ProviderResult {
    const id = this.generateId();
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = response.body?.getReader();
        if (!reader) { controller.close(); return; }
        const decoder = new TextDecoder();
        let buffer = "";
        let promptTokens = 0, completionTokens = 0, totalTokens = 0;

        const emit = (delta: any, finish_reason: string | null = null, usage?: any) => {
          const chunk: any = {
            id,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta, finish_reason }],
          };
          if (usage) chunk.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        try {
          emit({ role: "assistant" });

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;

              try {
                const chunk = JSON.parse(payload);
                const choice = chunk.choices?.[0];
                if (choice?.delta?.content) {
                  emit({ content: choice.delta.content });
                }
                if (choice?.delta?.reasoning_content) {
                  emit({ reasoning_content: choice.delta.reasoning_content } as any);
                }
                if (chunk.usage) {
                  promptTokens = chunk.usage.prompt_tokens || 0;
                  completionTokens = chunk.usage.completion_tokens || 0;
                  totalTokens = chunk.usage.total_tokens || (promptTokens + completionTokens);
                }
              } catch { /* skip non-JSON */ }
            }
          }

          const usage = totalTokens > 0
            ? { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens }
            : undefined;
          emit({}, "stop", usage);
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (error) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: "api_error" } })}\n\n`
          ));
        } finally {
          controller.close();
        }
      },
    });

    return { success: true, stream, tokensUsed: 0 };
  }
}
