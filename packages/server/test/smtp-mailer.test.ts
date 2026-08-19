import { test } from "node:test";
import assert from "node:assert/strict";
import { SmtpMailer, type MailTransport } from "../src/smtp-mailer";

test("SmtpMailer delivers the message + embeds the signing link in the body", async () => {
  const sent: { from: string; to: string; subject: string; text: string }[] = [];
  const transport: MailTransport = {
    async sendMail(msg) {
      sent.push(msg);
    },
  };
  const mailer = new SmtpMailer(transport, "FineSign <no-reply@finesign.test>");

  await mailer.send({
    to: "alice@x.test",
    subject: "Please sign: NDA",
    text: "Alice, you have a document to sign: NDA.",
    link: "https://finesign.test/sign/tok-123",
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "alice@x.test");
  assert.equal(sent[0].from, "FineSign <no-reply@finesign.test>");
  assert.equal(sent[0].subject, "Please sign: NDA");
  // The recipient's email body carries the link (delivery is its purpose).
  assert.match(sent[0].text, /https:\/\/finesign\.test\/sign\/tok-123/);
});

test("SmtpMailer omits the link line when there is none", async () => {
  const sent: { text: string }[] = [];
  const transport: MailTransport = {
    async sendMail(msg) {
      sent.push(msg);
    },
  };
  const mailer = new SmtpMailer(transport, "from@x.test");
  await mailer.send({ to: "b@x.test", subject: "Completed", text: "All done." });
  assert.doesNotMatch(sent[0].text, /Open your document/);
});
