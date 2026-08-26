import type { CloudflareBindings } from "./context.js";
import { logger } from "./logger.js";

interface SendInviteEmailParams {
  to: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
}

// Fire-and-forget relative to the caller: never throws. The invitation row
// is already the source of truth by the time this is called (design spec
// §5) - a Postmark outage or an unset token degrades to "share the link
// manually" rather than failing invite creation (scaling-resilience.md
// rule 1's timeout, error-handling-logging.md rule 6's "log it, don't
// swallow silently").
export async function sendInviteEmail(
  env: CloudflareBindings,
  params: SendInviteEmailParams,
): Promise<boolean> {
  if (!env.POSTMARK_SERVER_TOKEN) return false;

  try {
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN,
      },
      body: JSON.stringify({
        From: env.POSTMARK_FROM_EMAIL || "no-reply@example.com",
        To: params.to,
        Subject: `${params.inviterName} invited you to join ${params.orgName}`,
        TextBody: `${params.inviterName} invited you to join ${params.orgName} on the Salary Management app.\n\nAccept: ${params.acceptUrl}\n\nThis link expires in 7 days.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, "postmark send failed (non-2xx)");
    }
    return res.ok;
  } catch (err) {
    logger.error({ err: String(err) }, "postmark send failed");
    return false;
  }
}
