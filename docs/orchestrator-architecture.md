# Agent Orchestrator & HITL Runtime — Architecture

**Status: architecture, not implemented.** Everything referenced below with
a file path is real and already deployed. Everything under §4
("Isolation") past the deterministic-diff line is a design for
infrastructure this repo's deploy target (Cloudflare Workers) cannot host,
not code sitting somewhere unbuilt in this repo. This document exists to
make that boundary explicit and to describe what a real build-out looks
like once a separate compute layer exists.

## Why this is architecture-only

Cloudflare Workers isolates cannot spawn a child process, cannot run a
microVM, and cannot hold a long-lived connection across requests the way a
real agent loop's "thought → action → observation" cycle usually assumes.
A Firecracker-isolated sandbox — the actual isolation mechanism named in
the original design brief — needs a machine that can boot a microVM, which
is categorically outside what an edge Worker is. So the question this repo
had to answer honestly was: which pieces of "orchestrator + HITL runtime"
*can* be built on this stack for real, and which genuinely need different
infrastructure? The split below is the answer, and every "built" claim
here is backed by a file and a test suite, not a plan.

## 1. The five rules, as enforced constraints (not aspirations)

| Rule | Where it's enforced |
|---|---|
| LLMs never do math | Every dollar/tax/vesting/forecast figure comes from a pure function with zero `fetch()`/`complete()` calls in it — `payroll-engine.ts`, `tax-rule-diff.ts`, `treasury-forecast.ts`, `total-landed-cost.ts`, `rsu-optimizer.ts`. Each has hand-verified unit tests asserting exact numbers, not "close enough." |
| Event sourcing, no row mutation | `ledger_events` is append-only; a correction is a new `reversal` event referencing what it reverses (unique index prevents double-reversal) — `schema.payroll.ts`. |
| Strict ACID on the core ledger | Every ledger write (posting a payroll run, approving an EWA advance) happens inside `db.transaction()` alongside its balance legs, never as two separate statements — `payroll-runs.controller.ts`, `ewa.controller.ts`. |
| AI runs sandboxed, produces a diff, requires human sign-off | `ai_proposals` table + the review endpoint below (§3). Nothing an AI produces anywhere in this app writes to `ledger_events`, `salary_records`, or any tax rule directly. |
| Zero-trust PII | `pii_tokens` + `lib/pii.ts` — a name is AES-GCM-encrypted and replaced with an opaque UUID token before it ever reaches `toToon()` or a model prompt. Tested by grepping the actual stored payload for the raw PII substring and asserting absence (`payroll.routes.test.ts`), not just asserting a function was called. |

## 2. Core Agent Orchestrator — built (the state-machine half)

An "agent step" in this codebase is one call to a resumable job runner, not
a long-lived in-memory loop:

- **State machine**: `jobs.status`: `queued → running → succeeded / failed /
  cancelled`, plus a stored `cursor` marking exactly how far a multi-step
  task has gotten (`models/jobs.ts`, `models/schema.ts`'s `jobs` table).
- **One step, one request**: `advanceBulkDelete()` processes `JOB_CHUNK_SIZE`
  (500) rows, commits, and returns — never a request that tries to do
  everything at once. `POST /jobs/:id/advance` is the generalized shape any
  future agent step would call into.
- **Idempotency**: every job carries a `runToken` (`newRunToken()`), so a
  retried "advance" call is provably the same logical step, not a duplicate
  one. Combined with the cursor, a crash mid-run redoes at most one chunk
  and never double-processes a row — this is the actual idempotency
  guarantee `idempotency.md`'s rule 2 (QStash retries 3x by default) needs.
- **Observability**: every step appends to `job_logs` (`appendJobLog()`) —
  an agent's "thought" log, in the same durable place its "action" result
  lives, queryable per-job rather than scattered across a Worker's ephemeral
  console output.
- **Reused, not duplicated**: `startPreflightAudit()` and
  `proposeTaxRuleDiff()` both create a `jobs` row before calling the model
  and mark it `succeeded`/logged on completion — the two AI-calling routes
  in this app already run through this same job-tracking spine, not a
  separate ad hoc mechanism per feature.

**What a real multi-step agent loop adds on top of this, unbuilt**: a
runner that itself calls `POST /jobs/:id/advance` repeatedly without a
human in the loop for each step (currently every "advance" here is
triggered by a client poll or an explicit action) — that's a queue
consumer (QStash/Cloudflare Queues), not a redesign of the state machine
itself. `README.md`'s own "Where it would go next" section already flags
this same wiring gap for the bulk-delete runner.

## 3. HITL Authorization Gateway — built

Every AI-adjacent feature in this app funnels through one table and one
review endpoint:

- **`ai_proposals`**: `proposalType` (`preflight_anomaly` | `tax_diff`),
  `status` (`pending` | `approved` | `rejected`), `diff` (the deterministic,
  human-readable payload — never free text the model can hide something
  in), `modelUsed`, `signOffHash`.
- **`POST /ai-proposals/:proposalId/review`** (`payroll-audit.controller.ts`
  `reviewProposal()`) is the *only* place a proposal's status can change.
  It's reused verbatim by both features that currently create proposals
  (pre-flight audit, tax-rule diff) — a third AI feature needs zero new
  review code, just a new `proposalType`.
- **Sign-off is cryptographically bound to what was actually reviewed**:
  `signOffHash = sha256(JSON.stringify(diff) + reviewerId + reviewedAt +
  decision)`. If the diff were mutated after the fact, the hash wouldn't
  match — the review isn't just a status flag, it's evidence of exactly
  what was approved.
- **Review-once, enforced, not just documented**: a second review attempt
  on an already-reviewed proposal 409s (tested in both
  `payroll.routes.test.ts` and the tax-rules suite) — there's no path for
  an approval to be silently overwritten or re-triggered.
- **Deterministic subsystems reject malformed AI output before it reaches
  this gate at all** (Rule #4's other half): `AnomalyFindings` and
  `ProposedBracketsFromModel` are zod schemas the model's raw text must
  parse against; a mismatch is stored as `{ unparsed: <raw text> }` rather
  than coerced into something it isn't — the human reviewing it sees "the
  model's output didn't parse," never a fabricated structured diff.

**Deliberately not gated by this mechanism**: `treasury-forecast.ts`,
`total-landed-cost.ts`, `rsu-optimizer.ts`. They have no AI in them at all
— gating a pure function's output behind human sign-off would be
theater, not safety. The gate exists specifically for the moment an LLM's
output could otherwise reach something consequential; a deterministic
calculator was never that moment.

## 4. Isolation / sandbox layer

**Built**: the deterministic half of "run this against a sandbox and diff
the result" — `lib/tax-rule-diff.ts`'s `computeTaxRuleDiff()` runs the
exact same `progressiveTax()` the real payroll engine runs, once against
the live bracket table and once against an AI-proposed replacement, over a
fixed set of representative salaries, and reports the delta. This is
"sandboxed" in the sense that matters most here: the comparison never
touches a real employee's real pay, never writes to `ledger_events`, and
is pure computation with no network egress at all.

**Not built, genuinely needs different infrastructure**: running
arbitrary LLM-*generated code* (not just a bracket table) against golden
historical data inside an isolated, egress-whitelisted, TTL-bounded
microVM. The shape, if built:

1. **Trigger**: an admin submits new rule logic (not just parameters); a
   `jobs` row of `type: 'legal_diff_sandbox'` is created — reusing
   `jobs`/`job_logs` exactly as they exist today (§2), no new state
   machine needed.
2. **Execution layer**: a separate service — Firecracker microVM,
   Cloudflare's own Sandbox SDK, or a Fly.io machine (a build choice, not
   an architecture choice) — runs the generated code against a fixed set
   of historical `ledgerEvents` as golden input. Egress is whitelisted to
   *nothing*: no network access from inside the sandbox at all, since it's
   pure computation over data already handed to it. A hard TTL (e.g. 5
   minutes) kills the container regardless of whether it finished —
   `scaling-resilience.md` rule 6's "fail fast, don't retry-loop" applied
   to a compute boundary instead of an HTTP call.
3. **Callback**: the sandbox posts its output back to a webhook — same
   shared-secret gate as `hris.controller.ts`'s ingestion endpoint, same
   idempotent-upsert discipline. The callback computes the diff (old rule's
   output vs. new rule's output on the same golden events, deterministically
   in the Worker, not the sandbox) and writes one `ai_proposals` row exactly
   as `proposeTaxRuleDiff()` does today.
4. **Sign-off**: unchanged — §3's existing review endpoint and sign-off
   hash apply identically regardless of whether the diff came from a
   parameter change or a sandboxed code run.
5. **Loop guard**: the sandbox call carries the `jobs.id` as its
   idempotency key and a `maxIterations` counter in `jobs.params`, mirroring
   the `runToken` pattern §2 already uses — a retry storm can't re-trigger
   the same sandbox run twice or spin unbounded.

Nothing in this section needs new *application* design once it's built —
it slots into the job/proposal spine that already exists. What it needs is
a compute target outside this Workers deployment, which is an
infrastructure decision for whoever owns the next phase, not a code gap in
this repo.

## 5. Safeguards — built, cross-cutting

- **Max-loop guard**: `jobs.params.maxIterations` (design, ready to use —
  the current jobs never actually loop unboundedly since bulk-delete's
  cursor makes forward progress guaranteed and every AI call happens
  exactly once per request).
- **Idempotency keys**: `runToken` (jobs), the unique
  `(organizationId, source, externalId)` index (HRIS punches,
  `schema.payroll.ts`), `onConflictDoNothing()`/`onConflictDoUpdate()`
  everywhere a webhook or retry could double-fire.
- **Rate limiting**: `rateLimitByOrg(10, 3600)` on every route that calls
  `complete()` (pre-flight audit, tax-rule diff's `legalText` path) — the
  only two places in this app that spend real money per call.
- **Zero-trust PII boundary**: enforced at the point of construction
  (`toToon()`'s input is built from tokenized rows, never raw ones), not
  merely as a code-review convention — see §1's test-backed claim.

## 6. Scoreboard

| Piece | Status |
|---|---|
| Resumable job state machine | ✅ built (`models/jobs.ts`, reused by 2 AI features) |
| HITL review/sign-off gateway | ✅ built (`ai_proposals`, reused by 2 AI features) |
| Deterministic tool-output validation | ✅ built (zod schemas gate every model response) |
| Deterministic "sandbox" diff (parameters) | ✅ built (`tax-rule-diff.ts`) |
| Isolated microVM code execution | ❌ architecture only (§4) — needs non-Workers compute |
| Autonomous multi-step agent loop (no human trigger per step) | ❌ architecture only (§2's closing note) — needs a queue consumer |
| Max-loop-guard field | 🟡 schema-ready (`jobs.params`), not yet exercised by a looping caller |
