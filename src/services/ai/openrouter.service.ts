import axios, { type AxiosInstance } from "axios";

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
      timeout: 30_000,
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
}

export function createOpenRouterClient(apiKey: string): OpenRouterClient {
  return new OpenRouterClient(apiKey);
}
