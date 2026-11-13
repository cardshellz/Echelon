/**
 * @echelon/notifications — Notification system and email transport
 *
 * Tables owned: notificationTypes, notificationPreferences, notifications
 * Depends on: identity (user lookups)
 * Callable by: any module through narrow `*.api.ts` facades or this barrel (`CI-03`).
 */

export { notify, type NotifyPayload } from "./in-app-notifications.api";
export { isSmtpConfigured, sendEmail, type EmailDeliveryResult } from "./email-delivery.api";
export { registerNotificationRoutes } from "./routes.api";
