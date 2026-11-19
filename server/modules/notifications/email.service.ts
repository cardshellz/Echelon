/**
 * email.service.ts
 * Generic SMTP transport wrapper for transactional emails.
 *
 * Domain-specific email composition (such as supplier purchase order snapshots)
 * belongs in its owning domain module, never in notifications (`PLAT-10`).
 *
 * Required env vars:
 *   SMTP_HOST   — e.g. smtp.gmail.com
 *   SMTP_PORT   — e.g. 587
 *   SMTP_USER   — e.g. you@gmail.com
 *   SMTP_PASS   — Gmail App Password (Settings → Security → App passwords)
 *   SMTP_FROM   — display name + address, e.g. "Acme Corp <you@gmail.com>"
 */

import nodemailer from "nodemailer";

export function isSmtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

export interface EmailDeliveryResult {
  messageId: string | null;
  response: string | null;
  accepted: string[];
  rejected: string[];
}

export async function sendEmail(opts: {
  to: string;
  cc?: string;
  subject: string;
  html: string;
  text?: string;
  messageId?: string;
}): Promise<EmailDeliveryResult> {
  if (!isSmtpConfigured()) {
    throw new Error("SMTP is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in your environment.");
  }
  const transporter = createTransport();
  const result = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
    messageId: opts.messageId,
  });
  return {
    messageId: typeof result.messageId === "string" ? result.messageId : null,
    response: typeof result.response === "string" ? result.response : null,
    accepted: Array.isArray(result.accepted) ? result.accepted.map(String) : [],
    rejected: Array.isArray(result.rejected) ? result.rejected.map(String) : [],
  };
}
