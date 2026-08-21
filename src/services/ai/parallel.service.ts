import axios, { type AxiosInstance } from "axios";

export interface ParallelTaskRunInput {
  input: string;
  processor?: "base" | "core" | "pro";
}

export interface ParallelTaskRunResult {
  runId: string;
  status: string;
  output?: unknown;
}

export class ParallelClient {
  private readonly http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: "https://api.parallel.ai/v1",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
  }

  async runTask(input: ParallelTaskRunInput): Promise<ParallelTaskRunResult> {
    const { data } = await this.http.post<ParallelTaskRunResult>("/tasks/runs", {
      input: input.input,
      processor: input.processor ?? "base",
    });
    return data;
  }

  async getRun(runId: string): Promise<ParallelTaskRunResult> {
    const { data } = await this.http.get<ParallelTaskRunResult>(
      `/tasks/runs/${runId}`,
    );
    return data;
  }
}

export function createParallelClient(apiKey: string): ParallelClient {
  return new ParallelClient(apiKey);
}
