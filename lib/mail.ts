import nodemailer, { type Transporter } from "nodemailer";

/**
 * Outbound email, on one SMTP mailbox.
 *
 * The portal sends exactly one kind of message — the sign-in verification code
 * — so this module is deliberately not a mail framework: one transport, one
 * `sendMail`, and a configuration check that can be asked about before anything
 * commits to sending.
 *
 * **Everything here is server-only.** The credentials are read from
 * `process.env` with no `NEXT_PUBLIC_` prefix, so Next has nothing to inline
 * into a browser bundle, and the only importers are route handlers and
 * `lib/loginOtp.ts`. Nodemailer itself would fail the build if it were ever
 * pulled into a client component, which is a second, structural guarantee on
 * top of the naming one.
 *
 * **Nothing is logged that identifies the message.** Errors are reported to the
 * caller as a boolean; the code being carried never appears in a log line, an
 * exception message or a response body.
 */

const HOST = process.env.SMTP_HOST ?? "";
const PORT = Number(process.env.SMTP_PORT ?? "465");
const USER = process.env.SMTP_USER ?? "";
const PASSWORD = process.env.SMTP_PASSWORD ?? "";
/** Falls back to the authenticating mailbox, which is what Hostinger requires anyway. */
const FROM = process.env.SMTP_FROM || USER;

/**
 * Whether mail can be sent at all.
 *
 * Checked by the login route *before* the password is even accepted as a
 * complete sign-in, so a deployment that forgot the SMTP variables fails with
 * "we could not send your code" rather than quietly falling back to a
 * password-only session. The safe direction to fail is no session.
 */
export function isMailConfigured(): boolean {
  return Boolean(HOST && PORT && USER && PASSWORD && FROM);
}

/**
 * One transport for the process, built on first use.
 *
 * Nodemailer pools connections itself; building it lazily keeps a missing or
 * malformed configuration from throwing at import time, which would take the
 * whole route down instead of one request.
 */
let transporter: Transporter | null = null;

function transport(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: HOST,
    port: PORT,
    // Port 465 is implicit TLS (SMTPS), which is what Hostinger publishes and
    // what the example configuration uses. 587 is STARTTLS, so the flag is
    // derived from the port rather than hard-coded — a deployment that moves to
    // 587 keeps working without a code change.
    secure: PORT === 465,
    auth: { user: USER, pass: PASSWORD },
    pool: true,
    maxConnections: 2,
    // A sign-in is waiting on this: better a clear failure than a request that
    // hangs until the browser gives up.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/**
 * Send one message. Returns whether it went out; never throws.
 *
 * The failure is logged without the recipient, the subject or the body — the
 * caller already knows which message it was trying to send, and an SMTP error
 * string is quite capable of quoting the payload back at you.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  if (!isMailConfigured()) {
    console.error("sendMail: SMTP is not configured; message not sent.");
    return false;
  }

  try {
    await transport().sendMail({
      from: `"SpiderHunts Leads Portal" <${FROM}>`,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return true;
  } catch (error) {
    console.error(
      "sendMail: SMTP delivery failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    return false;
  }
}
