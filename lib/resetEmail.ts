import type { Mail } from "./mail";

/**
 * The password-reset code email.
 *
 * The sibling of `lib/otpEmail.ts` and written to the same rules — table
 * layout, inline styles, no external stylesheet, no web font, no remote image,
 * and a plain-text part that is a real alternative rather than a stripped copy.
 * Kept in its own file for the same reason that one is: the copy should be
 * readable and changeable without going near the code that decides whether a
 * reset succeeds.
 *
 * Two differences from the sign-in code, both deliberate:
 *
 *   it names no account   the address it arrived at is the only identifier in
 *                         it, so a forwarded or mis-delivered message tells the
 *                         reader nothing about whose portal login it belongs to
 *   it says what to do    "you did not ask for this" is a real possibility here
 *                         — anyone who knows a username can cause this mail to
 *                         be sent — so the message has to state plainly that
 *                         the existing password still works and that ignoring
 *                         the email is the whole of the required response
 *
 * As with the sign-in code there is no link of any kind, so there is nothing
 * here that can be phished into being clicked.
 */

export const RESET_EMAIL_SUBJECT = "Your SpiderHunts password reset code";

export function buildResetEmail(to: string, code: string, ttlMinutes: number): Mail {
  const text = [
    "Your password reset code is:",
    "",
    code,
    "",
    `This code expires in ${ttlMinutes} minutes and can be used once.`,
    "",
    "If you did not ask to reset your password, you can ignore this email.",
    "Your current password still works and nothing has changed.",
    "",
    "— SpiderHunts Leads Portal",
  ].join("\n");

  // Letter-spaced and monospaced for the same reason the sign-in code is: the
  // alphabet already excludes 0/O and 1/I/L, and the typeface should not
  // reintroduce the confusion the alphabet was chosen to avoid.
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
                  Your password reset code is:
                </h1>
                <p style="margin:0 0 24px 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  Enter this code on the sign-in screen to choose a new password.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td align="center" style="background:#f4f5f7;border:1px solid #e3e5e9;border-radius:10px;padding:20px 12px;">
                      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;font-weight:700;letter-spacing:0.18em;color:#111827;">${code}</span>
                    </td>
                  </tr>
                </table>
                <p style="margin:24px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  This code expires in ${ttlMinutes} minutes and can be used once.
                </p>
                <p style="margin:12px 0 0 0;font-size:14px;line-height:1.6;color:#4b5563;">
                  If you did not ask to reset your password, you can ignore this
                  email. Your current password still works and nothing has
                  changed.
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

  return { to, subject: RESET_EMAIL_SUBJECT, text, html };
}
