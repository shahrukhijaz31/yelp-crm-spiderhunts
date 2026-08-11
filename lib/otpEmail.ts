import type { Mail } from "./mail";

/**
 * The verification-code email.
 *
 * Kept apart from `lib/loginOtp.ts` so the copy can be read and changed without
 * going near the code that decides whether a sign-in succeeds.
 *
 * Written to the rules that make an email survive contact with a real client:
 * table layout, inline styles, no external stylesheet, no web font, no remote
 * image — a logo hosted on the portal would be blocked by default in most
 * inboxes and would leak a read receipt in the rest. The plain-text part is a
 * real alternative rather than a stripped copy, because a code that cannot be
 * read is a lockout.
 *
 * What it deliberately does not contain: the password, the username, any link
 * at all (nothing here is clickable, so nothing here can be phished into being
 * clicked), and any hint about which account beyond the address it was sent to.
 */

export const OTP_EMAIL_SUBJECT = "Your SpiderHunts verification code";

export function buildOtpEmail(to: string, code: string, ttlMinutes: number): Mail {
  const text = [
    "Your verification code is:",
    "",
    code,
    "",
    `This code expires in ${ttlMinutes} minutes.`,
    "",
    "If you did not attempt to sign in, you can safely ignore this email.",
    "",
    "— SpiderHunts Leads Portal",
  ].join("\n");

  // The digits are letter-spaced and monospaced so 0/O and 1/l cannot be
  // confused when someone reads them off a phone, and selectable as one run so
  // copy-paste picks up six characters and no stray spaces.
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
                  Your verification code is:
                </h1>
                <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  Enter this code on the sign-in screen to finish signing in.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td align="center" style="background:#f4f5f7;border:1px solid #e3e5e9;border-radius:10px;padding:20px 12px;">
                      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:700;letter-spacing:0.32em;color:#111827;">${code}</span>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  This code expires in ${ttlMinutes} minutes.
                </p>
                <p style="margin:12px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  If you did not attempt to sign in, you can safely ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <hr style="border:0;border-top:1px solid #e3e5e9;margin:0 0 16px 0;" />
                <p style="margin:0;font-size:12px;line-height:1.6;color:#9aa0aa;">
                  This is an automated message from the SpiderHunts Leads Portal.
                  Nobody will ever ask you for this code.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { to, subject: OTP_EMAIL_SUBJECT, text, html };
}
