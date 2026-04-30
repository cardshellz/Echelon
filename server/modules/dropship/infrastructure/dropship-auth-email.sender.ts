import { sendEmail } from "../../notifications/email.service";
import type { DropshipAuthEmailSender } from "../application/dropship-auth-service";
import type { DropshipSensitiveAction } from "../domain/auth";

export class SmtpDropshipAuthEmailSender implements DropshipAuthEmailSender {
  async sendVerificationCode(input: {
    toEmail: string;
    code: string;
    action: DropshipSensitiveAction;
    expiresAt: Date;
  }): Promise<void> {
    const label = getActionLabel(input.action);
    await sendEmail({
      to: input.toEmail,
      subject: `Card Shellz dropship verification code`,
      text: [
        `Your Card Shellz dropship verification code is ${input.code}.`,
        `Use it to continue: ${label}.`,
        `This code expires at ${input.expiresAt.toISOString()}.`,
      ].join("\n"),
      html: [
        "<p>Your Card Shellz dropship verification code is:</p>",
        `<p style="font-size:24px;font-weight:700;letter-spacing:4px;">${input.code}</p>`,
        `<p>Use it to continue: ${escapeHtml(label)}.</p>`,
        `<p>This code expires at ${input.expiresAt.toISOString()}.</p>`,
      ].join(""),
    });
  }
}

function getActionLabel(action: DropshipSensitiveAction): string {
  switch (action) {
    case "account_bootstrap":
      return "set up your dropship portal login";
    case "password_reset":
      return "reset your dropship portal password";
    case "register_passkey":
      return "register a passkey";
    case "connect_store":
      return "connect a store";
    case "disconnect_store":
      return "disconnect a store";
    case "change_password":
      return "change your password";
    case "change_contact_email":
      return "change your contact email";
    case "add_funding_method":
      return "add a funding method";
    case "remove_funding_method":
      return "remove a funding method";
    case "wallet_funding_high_value":
      return "fund your dropship wallet";
    case "bulk_listing_push":
      return "push listings in bulk";
    case "high_risk_order_acceptance":
      return "accept a high-risk order";
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
