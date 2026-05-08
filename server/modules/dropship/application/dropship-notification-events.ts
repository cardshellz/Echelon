export const DROPSHIP_NOTIFICATION_EVENTS = {
  AUTO_RELOAD_FAILED: "dropship_auto_reload_failed",
  ENTITLEMENT_BLOCKED: "dropship_entitlement_blocked",
  LISTING_PUSH_FAILED: "dropship_listing_push_failed",
  ORDER_ACCEPTED: "dropship_order_accepted",
  ORDER_INTAKE_REJECTED: "dropship_order_intake_rejected",
  ORDER_PAYMENT_HOLD: "dropship_order_payment_hold",
  ORDER_PAYMENT_HOLD_EXPIRED: "dropship_order_payment_hold_expired",
  ORDER_PAYMENT_HOLD_EXPIRING: "dropship_order_payment_hold_expiring",
  ORDER_PROCESSING_FAILED: "dropship_order_processing_failed",
  ORDER_PROCESSING_RETRYING: "dropship_order_processing_retrying",
  ORDER_RECEIVED: "dropship_order_received",
  ORDER_REJECTED: "dropship_order_rejected",
  RETURN_CREDIT_POSTED: "dropship_return_credit_posted",
  RMA_OPENED: "dropship_rma_opened",
  STORE_DISCONNECTED: "dropship_store_disconnected",
  STORE_NEEDS_REAUTH: "dropship_store_needs_reauth",
  TRACKING_PUSH_FAILED: "dropship_tracking_push_failed",
  TRACKING_PUSHED: "dropship_tracking_pushed",
  WALLET_FUNDING_FAILED: "dropship_wallet_funding_failed",
} as const;

export type DropshipNotificationEventType =
  typeof DROPSHIP_NOTIFICATION_EVENTS[keyof typeof DROPSHIP_NOTIFICATION_EVENTS];

export const DROPSHIP_NOTIFICATION_EVENT_TYPES = Object.values(
  DROPSHIP_NOTIFICATION_EVENTS,
) as DropshipNotificationEventType[];
