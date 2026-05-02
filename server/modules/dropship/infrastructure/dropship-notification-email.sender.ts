import { sendEmail } from "../../notifications/email.service";
import type { DropshipNotificationEmailSender } from "../application/dropship-notification-service";

export class SmtpDropshipNotificationEmailSender implements DropshipNotificationEmailSender {
  async send(input: {
    toEmail: string;
    eventType: string;
    title: string;
    message: string | null;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await sendEmail({
      to: input.toEmail,
      subject: input.title,
      text: buildTextBody(input),
      html: buildHtmlBody(input),
    });
  }
}

function buildTextBody(input: {
  title: string;
  message: string | null;
  eventType: string;
}): string {
  return [
    input.title,
    input.message ?? "",
    `Event: ${input.eventType}`,
  ].filter(Boolean).join("\n\n");
}

function buildHtmlBody(input: {
  title: string;
  message: string | null;
  eventType: string;
}): string {
  return [
    `<h1>${escapeHtml(input.title)}</h1>`,
    input.message ? `<p>${escapeHtml(input.message)}</p>` : "",
    `<p><strong>Event:</strong> ${escapeHtml(input.eventType)}</p>`,
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
