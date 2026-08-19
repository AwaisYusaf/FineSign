/**
 * Mailer — the notification-delivery interface (owned by the server, which
 * executes `NotifyEffect`s). `ConsoleMailer` prints (self-host default before
 * SMTP is configured); `CapturingMailer` records messages for tests.
 */
import type { Logger } from "@finesign/shared";

export interface SentMessage {
  to: string;
  subject: string;
  text: string;
  /** A signing link (contains a secret token) — delivered to the recipient,
   *  never logged. */
  link?: string;
}

export interface Mailer {
  send(message: SentMessage): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  constructor(private readonly logger: Logger) {}
  async send(message: SentMessage): Promise<void> {
    // SECURITY: never log the link/token — a signing link is a bearer credential
    // (S2). Log only the non-secret envelope of the message. `hasLink` lets ops
    // confirm a link was included without exposing it.
    this.logger.info(
      { type: "email", to: message.to, subject: message.subject, hasLink: Boolean(message.link) },
      "email sent"
    );
  }
}

export class CapturingMailer implements Mailer {
  readonly sent: SentMessage[] = [];
  async send(message: SentMessage): Promise<void> {
    this.sent.push(message);
  }
  /** All messages sent to a given address. */
  to(address: string): SentMessage[] {
    return this.sent.filter((m) => m.to === address);
  }
}
