/**
 * Narrow internal API facade for generic outbound SMTP email delivery (`CI-03`).
 *
 * Domain-specific email composition and outbox state belong in their owning domain modules.
 */
export { isSmtpConfigured, sendEmail, type EmailDeliveryResult } from "./email.service";
