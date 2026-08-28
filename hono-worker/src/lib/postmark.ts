import type { CloudflareBindings } from "./context.js";
import { logger } from "./logger.js";

interface SendInviteEmailParams {
  to: string;
  orgName: string;
  inviterName: string;
  acceptUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Organization and inviter names come from user input and land inside an HTML
// document, so they are escaped rather than interpolated raw
// (api-security.md rule 7).
function inviteHtml(p: SendInviteEmailParams): string {
  const orgName = escapeHtml(p.orgName);
  const inviterName = escapeHtml(p.inviterName);
  const url = escapeHtml(p.acceptUrl);
  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:6px">
    <tr><td style="padding:28px">
      <p style="margin:0 0 16px;font-size:18px;font-weight:600">Join ${orgName}</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#334155">
        ${inviterName} invited you to ${orgName} on Salary Management.
      </p>
      <p style="margin:0 0 24px">
        <a href="${url}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:4px;font-size:14px;font-weight:500">Accept invitation</a>
      </p>
      <p style="margin:0 0 8px;font-size:12px;color:#64748b">Or paste this link into your browser:</p>
      <p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:#334155">${url}</p>
      <p style="margin:0;font-size:12px;color:#64748b">
        This link expires in 7 days. If you weren't expecting it, you can ignore this email.
      </p>
    </td></tr>
  </table>
</body></html>`;
}

// Fire-and-forget relative to the caller: never throws. The invitation row is
// already the source of truth by the time this is called (design spec §5) - a
// Postmark outage or an unset token degrades to "share the link manually"
// rather than failing invite creation.
export async function sendInviteEmail(
  env: CloudflareBindings,
  params: SendInviteEmailParams,
): Promise<boolean> {
  if (!env.POSTMARK_SERVER_TOKEN) return false;

  const text = `${params.inviterName} invited you to join ${params.orgName} on Salary Management.

Accept: ${params.acceptUrl}

This link expires in 7 days. If you weren't expecting this, you can ignore it.`;

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
        // Both parts: a text-only invite scores worse with spam filters, and
        // an HTML-only one renders as nothing in text clients.
        HtmlBody: inviteHtml(params),
        TextBody: text,
        MessageStream: "outbound",
        // Transactional mail should not carry Postmark's tracking pixel or
        // rewritten links; both hurt deliverability on a fresh domain.
        TrackOpens: false,
        TrackLinks: "None",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // Postmark's own error code is the actionable part (e.g. 300 invalid
      // sender signature, 412 account pending) - a bare status hides it.
      let detail = "";
      try {
        const body = (await res.json()) as { ErrorCode?: number; Message?: string };
        detail = `${body.ErrorCode ?? ""} ${body.Message ?? ""}`.trim();
      } catch {
        // Non-JSON body; the status alone will have to do.
      }
      logger.error({ status: res.status, detail }, "postmark send failed");
    }
    return res.ok;
  } catch (err) {
    logger.error({ err: String(err) }, "postmark send failed");
    return false;
  }
}
