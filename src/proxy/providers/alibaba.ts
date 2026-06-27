import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { config } from "../../config";
import { decrypt } from "../../utils/crypto";

/**
 * Alibaba (DashScope) Provider
 *
 * Routes requests to dashscope-intl.aliyuncs.com using API keys.
 * Each account = 1 DashScope API key with 1M free tokens per model.
 * When quota is exhausted for one account, PoolProxy2 rotates to the next.
 *
 * Model mapping: ali-xxx → xxx (strip prefix, send to DashScope)
 */
export class AlibabaProvider extends BaseProvider {
  name = "alibaba";
  private baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

  supportedModels: ModelInfo[] = [
    { id: "ali-glm-5.2", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 1048576, max_output: 16384, thinking: true, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-glm-5.1", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 1048576, max_output: 16384, thinking: true, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen-plus", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3-max", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3.7-max", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 1048576, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3.7-plus", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 1048576, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3.7-max-preview", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 1048576, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3-coder-plus", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3-coder-flash", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3-8b", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3-30b-a3b", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3.6-flash", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen3.6-plus", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen-flash", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-qwen-vl-max", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 4096, thinking: false, vision: true, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-deepseek-v3.2", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-deepseek-v4-pro", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-deepseek-v4-flash", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 8192, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
    { id: "ali-kimi-k2.7-code", object: "model", created: Date.now(), owned_by: "alibaba", tier: "standard", context_window: 131072, max_output: 16384, thinking: false, vision: false, creditUnit: "token", creditRate: 0.000001, creditSource: "estimated" },
  ];

  /** Strip "ali-" prefix to get the upstream DashScope model name */
  private resolveUpstreamModel(model: string): string {
    const m = model.toLowerCase();
    if (m.startsWith("ali-")) return m.slice(4);
    return m;
  }

  private getApiKey(account: Account): string | null {
    // API key stored encrypted in password field
    if (!account.password) return null;
    try {
      return decrypt(account.password);
    } catch {
      return account.password; // fallback if not encrypted
    }
  }

  // ─── Provider Interface ───────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key available" };

    const upstreamModel = this.resolveUpstreamModel(request.model);
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
        `${this.baseUrl}/chat/completions`,
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
        // Quota exhaustion: mark account as exhausted so it gets skipped
        if (text.includes("FreeTierOnly") || text.includes("exhausted") || text.includes("AllocationQuota")) {
          return { success: false, error: `Alibaba quota exhausted: ${text.slice(0, 200)}`, quotaExhausted: true };
        }
        return { success: false, error: `Alibaba auth error (${response.status}): ${text.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Alibaba rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Alibaba error (${response.status}): ${text.slice(0, 300)}` };
      }

      const data = await response.json() as any;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "Alibaba returned no choices" };

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

      const promptTokens = resp.usage.prompt_tokens;
      const completionTokens = resp.usage.completion_tokens;
      const totalTokens = resp.usage.total_tokens;

      return {
        success: true,
        response: resp,
        tokensUsed: totalTokens,
        promptTokens,
        completionTokens,
        creditsUsed: totalTokens * this.getProviderCreditRate(request.model),
        creditSource: "estimated",
      };
    } catch (error) {
      return { success: false, error: `Alibaba failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key available" };

    const upstreamModel = this.resolveUpstreamModel(request.model);
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
        `${this.baseUrl}/chat/completions`,
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
        if (text.includes("FreeTierOnly") || text.includes("exhausted") || text.includes("AllocationQuota")) {
          return { success: false, error: `Alibaba quota exhausted: ${text.slice(0, 200)}`, quotaExhausted: true };
        }
        return { success: false, error: `Alibaba auth error (${response.status}): ${text.slice(0, 200)}` };
      }
      if (response.status === 429) {
        return { success: false, error: "Alibaba rate limited", rateLimited: true };
      }
      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `Alibaba error (${response.status}): ${text.slice(0, 300)}` };
      }

      return this.createStreamResponse(response, request.model);
    } catch (error) {
      return { success: false, error: `Alibaba stream failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: false, error: "Alibaba uses API keys, no refresh needed" };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  async fetchQuota(): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    // DashScope doesn't expose a quota API — report unlimited
    return { success: true, quota: { limit: 1000000, remaining: 1000000, used: 0, resetAt: null } };
  }

  override async healthCheck(account: Account): Promise<ProviderHealthResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { kind: "missing_tokens", success: false, error: "Missing API key" };

    try {
      // Test with a tiny request
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "qwen-plus",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 1,
          }),
        },
        config.providerQuotaTimeoutMs
      );

      if (response.status === 401 || response.status === 403) {
        const text = await response.text();
        if (text.includes("FreeTierOnly") || text.includes("exhausted")) {
          return { kind: "exhausted", success: false, error: "Free quota exhausted" };
        }
        return { kind: "auth_error", success: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      }
      if (!response.ok) {
        return { kind: "transient_error", success: false, retryable: true, error: `HTTP ${response.status}` };
      }

      return {
        kind: "healthy",
        success: true,
        quota: { limit: 1000000, remaining: 1000000, used: 0, source: "alibaba.healthCheck" },
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
              // DashScope quirk: sometimes appends "data: [DONE]" after JSON
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
              } catch { /* skip non-JSON lines */ }
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
