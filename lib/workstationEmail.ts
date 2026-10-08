import type { Mail } from "./mail";

/**
 * "A workstation was connected to your account."
 *
 * Kept apart from `lib/monitorPairing.ts` so the copy can be read and changed
 * without going near the code that decides whether a workstation connects, the
 * same split `lib/otpEmail.ts` keeps from `lib/loginOtp.ts`. Same rules for
 * surviving a real mail client: table layout, inline styles, no external
 * stylesheet, no web font, no remote image, and a plain-text part that is a
 * real alternative rather than a stripped copy.
 *
 * ---------------------------------------------------------------------------
 * Why this email exists
 * ---------------------------------------------------------------------------
 * Connecting the Monitor takes one click and no code, which means the thing
 * standing between a phishing link and a workstation reporting under somebody
 * else's name is partly *noticing*. This is the noticing. It names the machine
 * and the time, and it points at the screen where one click ends it.
 *
 * It is sent after the credential is issued and its failure is ignored by the
 * caller: a mail outage must not cost an agent the connection they just
 * approved. That is a deliberate trade — the alternative, refusing to connect
 * when SMTP is down, would turn a notification into a dependency.
 *
 * ---------------------------------------------------------------------------
 * What it does not contain
 * ---------------------------------------------------------------------------
 * No token of any kind, no device id, no address, and nothing that acts on
 * being clicked. The one link goes to a page that requires a session and shows
 * the agent their own machines — so the worst a forwarded copy achieves is
 * sending somebody to a sign-in screen.
 */

export const WORKSTATION_CONNECTED_SUBJECT = "A workstation was connected to your account";

export function buildWorkstationConnectedEmail(input: {
  to: string;
  /** What the machine called itself, or null if it never said. */
  deviceName: string | null;
  platform: string | null;
  /** The portal's own address, for the one link. */
  portalUrl: string;
  connectedAt: Date;
}): Mail {
  const name = input.deviceName ?? "An unnamed computer";
  const platform = input.platform ? ` (${input.platform})` : "";
  const when = input.connectedAt.toUTCString();
  const link = `${input.portalUrl.replace(/\/+$/, "")}/account/workstations`;

  const text = [
    `${name}${platform} was just connected to your SpiderHunts account.`,
    "",
    `Connected: ${when}`,
    "",
    "It can now report your activity, screenshots and application usage while",
    "you are on the clock. Nothing is recorded outside your shift.",
    "",
    "If this was you, there is nothing to do.",
    "",
    "If it was not, disconnect it now and tell an administrator:",
    link,
    "",
    "— SpiderHunts Leads Portal",
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e5e9;border-radius:12px;">
            <tr>
              <td style="padding:32px 32px 24px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 24px 0;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#6b7280;">
                  SpiderHunts Leads Portal
                </p>
                <h1 style="margin:0 0 12px 0;font-size:20px;line-height:1.3;font-weight:600;color:#111827;">
                  A workstation was connected
                </h1>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td style="background:#f4f5f7;border:1px solid #e3e5e9;border-radius:10px;padding:16px 18px;">
                      <p style="margin:0;font-size:16px;font-weight:600;color:#111827;">${escapeHtml(name)}</p>
                      <p style="margin:6px 0 0 0;font-size:13px;line-height:1.6;color:#6b7280;">${escapeHtml(
                        `${input.platform ?? "Unknown platform"} · ${when}`,
                      )}</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  It can now report your activity, screenshots and application
                  usage while you are on the clock. Nothing is recorded outside
                  your shift.
                </p>
                <p style="margin:12px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  If this was you, there is nothing to do. If it was not,
                  disconnect it now and tell an administrator.
                </p>
                <p style="margin:24px 0 0 0;">
                  <a href="${escapeHtml(link)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 18px;border-radius:8px;">
                    See your workstations
                  </a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <hr style="border:0;border-top:1px solid #e3e5e9;margin:0 0 16px 0;" />
                <p style="margin:0;font-size:12px;line-height:1.6;color:#9aa0aa;">
                  This is an automated message from the SpiderHunts Leads Portal.
                  It is sent every time a workstation is connected, so that one
                  you did not expect is never silent.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to: input.to, subject: WORKSTATION_CONNECTED_SUBJECT, text, html };
}

/**
 * The device name is the one value here a *workstation* chose, so it is the one
 * value that could carry markup into an inbox.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
