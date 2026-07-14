/**
 * email.ts
 * Nodemailer wrapper for sending POs and other transactional emails.
 *
 * Required env vars:
 *   SMTP_HOST   — e.g. smtp.gmail.com
 *   SMTP_PORT   — e.g. 587
 *   SMTP_USER   — e.g. you@gmail.com
 *   SMTP_PASS   — Gmail App Password (Settings → Security → App passwords)
 *   SMTP_FROM   — display name + address, e.g. "Acme Corp <you@gmail.com>"
 */

import nodemailer from "nodemailer";
import { renderPoHtml } from "../procurement/po-document";
import { createPurchasingService } from "../procurement/purchasing.service";
import { procurementStorage } from "../procurement";
import { warehouseStorage } from "../warehouse";
import { catalogStorage } from "../catalog";
const storage = { ...procurementStorage, ...warehouseStorage, ...catalogStorage };
import { db } from "../../db";

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

export interface PurchaseOrderEmailSnapshot {
  subject: string;
  html: string;
  text: string;
  poNumber: string;
}

export async function buildPurchaseOrderEmail(opts: {
  poId: number;
  message?: string;
}): Promise<PurchaseOrderEmailSnapshot> {
  const purchasing = createPurchasingService(db, storage);
  const po = await purchasing.getPurchaseOrderById(opts.poId);
  if (!po) throw new Error("Purchase order not found");

  const [lines, vendor, settings] = await Promise.all([
    purchasing.getPurchaseOrderLines(opts.poId),
    storage.getVendorById(po.vendorId),
    storage.getAllSettings(),
  ]);

  let html = renderPoHtml({
    po,
    lines,
    vendor,
    companyName: settings.company_name ?? undefined,
    companyAddress: settings.company_address ?? undefined,
    companyCity: settings.company_city ?? undefined,
    companyState: settings.company_state ?? undefined,
    companyPostalCode: settings.company_postal_code ?? undefined,
    companyCountry: settings.company_country ?? undefined,
  });

  const personalMessage = opts.message?.trim() ?? "";
  if (personalMessage) {
    const msgHtml = `<div style="font-family:-apple-system,Arial,sans-serif;font-size:14px;color:#111;margin-bottom:24px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;">
      <p style="white-space:pre-wrap;">${escHtml(personalMessage)}</p>
    </div>`;
    html = html.replace("<body>", `<body>${msgHtml}`);
  }

  const companyName = settings.company_name || "Your Company";
  const subject = `Purchase Order ${po.poNumber} — ${companyName}`;
  const text = [
    personalMessage,
    `Purchase Order ${po.poNumber} from ${companyName}.`,
    "The complete purchase order is included in the HTML version of this email.",
  ].filter(Boolean).join("\n\n");

  return { subject, html, text, poNumber: po.poNumber };
}

export async function sendPurchaseOrder(opts: {
  poId: number;
  toEmail: string;
  ccEmail?: string;
  message?: string;
}): Promise<void> {
  const snapshot = await buildPurchaseOrderEmail({ poId: opts.poId, message: opts.message });
  await sendEmail({
    to: opts.toEmail,
    cc: opts.ccEmail,
    subject: snapshot.subject,
    html: snapshot.html,
    text: snapshot.text,
  });
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
