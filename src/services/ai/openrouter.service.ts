import axios, { type AxiosInstance } from "axios";
import type { Readable } from "node:stream";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

interface OpenRouterChatResponse {
  choices: { message: { content: string } }[];
}

export class OpenRouterClient {
  private readonly http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: "https://openrouter.ai/api/v1",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Kept under vercel.json's functions.maxDuration (60s) - a request
      // that outlives the function's own timeout gets killed ungracefully
      // mid-response instead of failing cleanly here first.
      timeout: 55_000,
    });
  }

  async chat(options: OpenRouterChatOptions): Promise<string> {
    const { data } = await this.http.post<OpenRouterChatResponse>(
      "/chat/completions",
      {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
      },
    );

    return data.choices[0]?.message.content ?? "";
  }

  /**
   * Streams completion tokens as they arrive instead of waiting for the
   * full response. Preferred for long generations: the caller (e.g. a
   * Fastify route piping to an SSE response) gets first-token latency
   * immediately rather than blocking for the whole generation, and an
   * early client disconnect stops wasted work.
   */
  async *chatStream(options: OpenRouterChatOptions): AsyncGenerator<string> {
    const response = await this.http.post<Readable>(
      "/chat/completions",
      {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
        stream: true,
      },
      { responseType: "stream" },
    );

    let buffer = "";
    for await (const chunk of response.data) {
      buffer += (chunk as Buffer).toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload) as {
            choices: { delta: { content?: string } }[];
          };
          const token = parsed.choices[0]?.delta.content;
          if (token) yield token;
        } catch {
          // Ignore malformed/partial SSE frames - next chunk completes them.
        }
      }
    }
  }
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  return new OpenRouterClient(apiKey);
}
