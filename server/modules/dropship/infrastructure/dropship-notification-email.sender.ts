import { sendEmail } from "../../notifications/email-delivery.api";
import type { DropshipNotificationEmailSender } from "../application/dropship-notification-service";

/**
 * A dropship notification as an email. The event type is internal (it routes
 * and dedupes the notification) and is never shown to the vendor. A message's
 * plain http(s) URLs stay plain in the text body and become links in the HTML
 * body, so a notice's words carry their links once, as text.
 */
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

function buildTextBody(input: { title: string; message: string | null }): string {
  return [input.title, input.message ?? ""].filter(Boolean).join("\n\n");
}

function buildHtmlBody(input: { title: string; message: string | null }): string {
  return [
    `<h1>${escapeHtml(input.title)}</h1>`,
    // A message's own lines stay lines (a publish run's email lists its sizes one per line, review DUX1).
    input.message ? `<p>${linkUrls(escapeHtml(input.message)).replace(/\n/g, "<br>")}</p>` : "",
  ].join("");
}

/**
 * http(s) URLs in already-escaped text, as links. A URL ends at whitespace or an
 * escaped quote or angle bracket; sentence punctuation right after it is left outside the link. The
 * URL was escaped with the rest of the text, so it is safe in the attribute.
 */
const ESCAPED_URL_PATTERN = /https?:\/\/(?:(?!&quot;|&lt;|&gt;)\S)+/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)]+$/;

function linkUrls(escaped: string): string {
  return escaped.replace(ESCAPED_URL_PATTERN, (match) => {
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(match)?.[0] ?? "";
    const url = match.slice(0, match.length - trailing.length);
    if (!url) return match;
    return `<a href="${url}">${url}</a>${trailing}`;
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
