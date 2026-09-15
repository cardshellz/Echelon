export class ChannelFulfillmentNotificationPolicyError extends Error {
  readonly code = "INVALID_CHANNEL_FULFILLMENT_NOTIFICATION_POLICY";
  readonly context = Object.freeze({ field: "notifyCustomer" });

  constructor() {
    super("Channel fulfillment notifyCustomer must be an explicit boolean when supplied");
    this.name = "ChannelFulfillmentNotificationPolicyError";
  }
}

/** Old commands omit this field and retain their original notification behavior. */
export function resolveChannelFulfillmentNotifyCustomer(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean") throw new ChannelFulfillmentNotificationPolicyError();
  return value;
}
