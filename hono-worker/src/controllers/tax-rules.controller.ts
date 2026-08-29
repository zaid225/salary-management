import type { Context } from "hono";
import type { z } from "zod/v4";
import { z as zod } from "zod/v4";
import { eq } from "drizzle-orm";
import { jobs, aiProposals } from "../models/schema.js";
import type { AppBindings } from "../lib/context.js";
import { LIVE_INCOME_TAX_BRACKETS, type TaxBracket } from "../lib/payroll-engine.js";
import { computeTaxRuleDiff, goldenSalariesMinor } from "../lib/tax-rule-diff.js";
import { complete } from "../lib/openrouter.js";
import { appendJobLog } from "../models/jobs.js";
import type { ProposeTaxRuleDiffBody } from "../schemas/payroll.schema.js";

// The wire shape the model is asked to return when extracting brackets from
// pasted legal text - validated before it can influence anything (Rule #4).
// null upToAnnualMinor is the JSON-safe stand-in for the engine's Infinity.
const ProposedBracketsFromModel = zod.object({
  brackets: zod
    .array(zod.object({ upToAnnualMinor: zod.number().positive().nullable(), rate: zod.number().min(0).max(1) }))
    .min(1)
    .max(20),
});

// Illustrative: cents/paise/pence per major currency unit is 100 for every
// jurisdiction this engine supports today (USD, INR, GBP) - if a
// zero-decimal currency (e.g. JPY) is ever added, this needs a per-currency
// lookup instead of a constant.
const MINOR_UNITS_PER_MAJOR = 100;

type ProposeIn = {
  in: { json: z.input<typeof ProposeTaxRuleDiffBody> };
  out: { json: z.infer<typeof ProposeTaxRuleDiffBody> };
};

/**
 * Legal-to-Code Compliance Diff Engine - the part of the sandbox design that
 * can actually run inside a Cloudflare Worker (see lib/tax-rule-diff.ts's
 * scope note for what's architecture-only). Two entry paths, one
 * deterministic tail:
 *
 *   legalText -> AI extracts a structured bracket table (Rule #4: validated
 *     before use, held unparsed on a schema mismatch, never trusted blind)
 *   proposedBrackets -> a human already has the exact numbers, no AI call
 *
 * Either way, the actual comparison - current brackets vs proposed, over
 * fixed golden salaries - is pure math (lib/tax-rule-diff.ts), never the
 * model. The result is stored as one ai_proposals row and requires the same
 * human sign-off review as every other AI-adjacent artifact in this app;
 * nothing here ever changes what a real payroll run computes (see plan §3 -
 * "apply this rule going forward" is a deliberately separate, unbuilt step).
 */
export async function proposeTaxRuleDiff(c: Context<AppBindings, string, ProposeIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { jurisdiction, legalText, proposedBrackets: directBrackets } = c.req.valid("json");

  const currentBrackets = LIVE_INCOME_TAX_BRACKETS[jurisdiction];
  if (!currentBrackets) {
    return c.json(
      { error: { message: `No live bracket set on file for jurisdiction "${jurisdiction}"`, statusCode: 400 } },
      400,
    );
  }

  const [job] = await db
    .insert(jobs)
    .values({
      organizationId: orgId,
      type: "tax_rule_diff",
      status: "running",
      total: 1,
      processed: 1,
      params: { jurisdiction, source: legalText ? "legal_text" : "direct" },
      runToken: crypto.randomUUID(),
      createdBy: userId,
    })
    .returning();
  if (!job) throw new Error("job insert did not return a row");

  let proposedBrackets: TaxBracket[] | null = null;
  let modelUsed: string | null = null;
  let unparsedModelText: string | null = null;
  let modelError: string | null = null;

  if (directBrackets) {
    proposedBrackets = directBrackets.map((b) => ({ upToAnnualMinor: b.upToAnnualMinor ?? Infinity, rate: b.rate }));
    await appendJobLog(db, job.id, "info", "Using brackets provided directly - no model call made.");
  } else {
    const model = "meta-llama/llama-3.1-8b-instruct";
    modelUsed = model;
    const result = await complete(c.env, {
      model,
      systemPrompt:
        "You extract income tax bracket tables from legal/regulatory text. " +
        "You never decide what the law should be - you only transcribe the brackets it already states. " +
        'Reply with strict JSON matching {"brackets":[{"upToAnnualMinor":number|null,"rate":number}]} and nothing else. ' +
        "rate is a decimal fraction (0.2 for 20%), not a percentage. " +
        "upToAnnualMinor is the upper bound of that bracket in minor currency units (cents/paise/pence), or null for the final, open-ended bracket. " +
        "Brackets must be ordered ascending by threshold.",
      userPrompt: legalText!,
      maxTokens: 1024,
    });

    if (!result.ok) {
      modelError = result.error;
      await appendJobLog(db, job.id, "error", `Model call failed: ${result.error}`);
    } else {
      const parsed = ProposedBracketsFromModel.safeParse(safeJsonParse(result.text));
      if (parsed.success) {
        proposedBrackets = parsed.data.brackets.map((b) => ({
          upToAnnualMinor: b.upToAnnualMinor ?? Infinity,
          rate: b.rate,
        }));
        await appendJobLog(db, job.id, "info", `Extracted ${parsed.data.brackets.length} bracket(s) from legal text.`);
      } else {
        // Rule #4: a malformed/hallucinated extraction is held for review,
        // never silently coerced into a bracket table that gets diffed.
        unparsedModelText = result.text;
        await appendJobLog(db, job.id, "warn", "Model output did not match the expected schema - stored unparsed.");
      }
    }
  }

  let diff: unknown;
  if (proposedBrackets) {
    const salaries = goldenSalariesMinor(MINOR_UNITS_PER_MAJOR);
    const ruleDiff = computeTaxRuleDiff(currentBrackets, proposedBrackets, salaries);
    diff = {
      jurisdiction,
      currentBrackets: serializeBrackets(currentBrackets),
      proposedBrackets: serializeBrackets(proposedBrackets),
      ...ruleDiff,
    };
  } else {
    diff = { jurisdiction, error: modelError, unparsed: unparsedModelText, scenarios: [] };
  }

  const [proposal] = await db
    .insert(aiProposals)
    .values({
      organizationId: orgId,
      proposalType: "tax_diff",
      status: "pending",
      jobId: job.id,
      diff,
      modelUsed,
    })
    .returning();

  await db.update(jobs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(jobs.id, job.id));

  return c.json({ proposal, jobId: job.id }, 202);
}

function serializeBrackets(brackets: TaxBracket[]): { upToAnnualMinor: number | null; rate: number }[] {
  return brackets.map((b) => ({
    upToAnnualMinor: Number.isFinite(b.upToAnnualMinor) ? b.upToAnnualMinor : null,
    rate: b.rate,
  }));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
