import type { CloudflareBindings } from "./context.js";
import { logger } from "./logger.js";

interface CompleteParams {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Caller must have already tokenized/stripped any raw PII from this string (Rule #5). */
  maxTokens?: number;
}

type CompleteResult = { ok: true; text: string } | { ok: false; error: string };

// Degrade-cleanly client, same contract as postmark.ts: never throws.
// Rule #1 ("LLMs never do math") means every caller of this treats the
// return value as a *suggestion* to store in ai_proposals, never as a
// number that gets written to ledgerEvents directly.
export async function complete(
  env: CloudflareBindings,
  params: CompleteParams,
): Promise<CompleteResult> {
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false, error: "OpenRouter not configured" };
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: params.maxTokens ?? 1024,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
      }),
      // scaling-resilience.md rule 1: every outbound call is time-bounded so
      // a slow upstream fails cleanly instead of running out the Worker.
      signal: AbortSignal.timeout(55_000),
    });

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        // Non-JSON error body; the status alone will have to do.
      }
      logger.error({ status: res.status, detail }, "openrouter request failed");
      return { ok: false, error: detail || `OpenRouter returned ${res.status}` };
    }

    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) {
      logger.error({}, "openrouter response had no message content");
      return { ok: false, error: "Empty response from model" };
    }
    return { ok: true, text };
  } catch (err) {
    logger.error({ err: String(err) }, "openrouter request failed");
    return { ok: false, error: String(err) };
  }
}
