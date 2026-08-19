/**
 * SMTP mailer adapter (X.3). Real delivery via nodemailer, behind an injected
 * `MailTransport` so the adapter is unit-testable without a live SMTP server
 * (tests inject a fake transport — the same seam the DOCX runner uses).
 *
 * Unlike the console mailer, this DELIVERS the signing link (in the message body
 * sent to the recipient) — that is the link's purpose. It is still never logged.
 */
import nodemailer from "nodemailer";
import type { Mailer, SentMessage } from "./mailer";

/** The minimal transport seam we depend on (a subset of nodemailer's API). */
export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string }): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
}

/** Wrap a real nodemailer SMTP transport as a `MailTransport`. */
export function makeNodemailerTransport(config: SmtpConfig): MailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure ?? config.port === 465,
    auth: config.auth,
  });
  return {
    async sendMail(msg) {
      await transporter.sendMail(msg);
    },
  };
}

export class SmtpMailer implements Mailer {
  constructor(
    private readonly transport: MailTransport,
    private readonly from: string
  ) {}

  async send(message: SentMessage): Promise<void> {
    const body = message.link
      ? `${message.text}\n\nOpen your document: ${message.link}\n`
      : `${message.text}\n`;
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: body,
    });
  }
}
