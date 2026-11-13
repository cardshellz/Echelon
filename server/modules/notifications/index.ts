/**
 * @echelon/notifications — Notification system and email transport
 *
 * Tables owned: notificationTypes, notificationPreferences, notifications
 * Depends on: identity (user lookups)
 * Callable by: any module
 */

export {
  notify,
  getUserNotifications,
  markRead,
  markAllRead,
  getUnreadCount,
  type NotifyPayload,
} from "./notifications.service";
export { isSmtpConfigured, sendEmail, type EmailDeliveryResult } from "./email.service";
export { registerNotificationRoutes } from "./notifications.routes";
