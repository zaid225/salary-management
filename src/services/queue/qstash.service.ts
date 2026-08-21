import { Client } from "@upstash/qstash";

type Delay = number | `${bigint}s` | `${bigint}m` | `${bigint}h` | `${bigint}d`;

export interface EnqueueOptions {
  /** Publicly reachable URL of the route that handles this job (a webhook). */
  url: string;
  body: unknown;
  /** Delay before delivery, e.g. "10s", "5m". */
  delay?: Delay;
  /** Retries on failure (QStash default is 3). */
  retries?: number;
}

/**
 * Wraps QStash for the "kick off work, return immediately, let a webhook
 * do the actual work" pattern - the correct way to run anything that might
 * exceed a serverless function's maxDuration (60s on Vercel Hobby). Don't
 * try to do long work inline in a request handler; publish it here instead
 * and have QStash call back into a dedicated route when it's ready to run.
 */
export class QStashQueue {
  private readonly client: Client;

  constructor(token: string) {
    this.client = new Client({ token });
  }

  async enqueue(options: EnqueueOptions): Promise<{ messageId: string }> {
    // publishJSON's return type is a union across url/urlGroup/api targets;
    // passing `url` (not `urlGroups`) always yields the variant with
    // messageId, but the overload resolution doesn't narrow that for us.
    const result = (await this.client.publishJSON({
      url: options.url,
      body: options.body,
      delay: options.delay,
      retries: options.retries,
    })) as { messageId: string };

    return { messageId: result.messageId };
  }
}

export function createQStashQueue(token: string): QStashQueue {
  return new QStashQueue(token);
}
