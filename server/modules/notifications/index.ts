/**
 * @echelon/notifications — Notification system and email
 *
 * Tables owned: notificationTypes, notificationPreferences, notifications
 * Depends on: identity (user lookups)
 * Callable by: any module
 */

export { notify, getUserNotifications, markRead, markAllRead, getUnreadCount } from "./notifications.service";
export { isSmtpConfigured, sendEmail, sendPurchaseOrder } from "./email.service";
