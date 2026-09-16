import { z } from "zod";

export const channelFulfillmentNotificationSuppressionSchema = z.object({
  requeueId: z.number().int().positive().safe(),
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  operator: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
  notifyCustomer: z.literal(false),
}).strict();
export type ChannelFulfillmentNotificationSuppression = z.infer<typeof channelFulfillmentNotificationSuppressionSchema>;

export function resolveReviewedChannelFulfillmentNotifyCustomer(input: {
  readonly provider: string;
  readonly source: unknown;
  readonly notifyCustomer: unknown;
  readonly requestHash: string;
  readonly suppression?: ChannelFulfillmentNotificationSuppression;
}): boolean {
  if (input.suppression === undefined) {
    return resolvePersistedChannelFulfillmentNotifyCustomer(input.provider, input.source, input.notifyCustomer);
  }
  const parsed = channelFulfillmentNotificationSuppressionSchema.safeParse(input.suppression);
  if (!parsed.success || input.provider !== "shopify" || parsed.data.requestHash !== input.requestHash) {
    throw new ChannelFulfillmentNotificationPolicyError();
  }
  // The command stays immutable; the attempt records the separately authorized
  // suppression. Even an old notifying repair may now be retried without email.
  return false;
}

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

/** Durable provenance values: keep these stable for commands written by older builds. */
export const CHANNEL_FULFILLMENT_REPAIR_SOURCES = Object.freeze({
  outboundSweep: "fulfillment_sweeper",
  missingShopifyWriteback: "oms_flow_missing_shopify_writeback",
  shopifyReconciler: "shopify_fulfillment_reconciler",
  shippedPackageRepair: "oms_flow_reconcile_shipped_package",
  legacyReconciliation: "legacy_fulfillment_reconciliation",
} as const);

export const CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX = "oms_flow_operator_remediation:";
const repairSources: ReadonlySet<string> = new Set(Object.values(CHANNEL_FULFILLMENT_REPAIR_SOURCES));

/** Catch-up is an operation kind, not a guessed age cutoff or a change to live shipping. */
export function isSilentShopifyFulfillmentRepair(channelProvider: string, source: unknown): boolean {
  return channelProvider === "shopify" && typeof source === "string"
    && (repairSources.has(source)
      || (source.startsWith(CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX)
        && source.length > CHANNEL_FULFILLMENT_OPERATOR_REPAIR_PREFIX.length));
}

export class ChannelFulfillmentRepairNotificationError extends Error {
  readonly code = "SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED";
  readonly context: Readonly<Record<string, unknown>>;

  constructor(source: unknown) {
    super("Shopify catch-up repair requires a silent command; review the existing notification-enabled request without rewriting its immutable intent");
    this.name = "ChannelFulfillmentRepairNotificationError";
    this.context = Object.freeze({ source, requiredNotifyCustomer: false });
  }
}

export function resolveNewChannelFulfillmentNotifyCustomer(
  channelProvider: string,
  source: unknown,
  value: unknown,
): boolean {
  // Only new repair commands acquire this default. An explicit contradictory
  // choice is rejected, rather than silently changing what the caller requested.
  if (value === undefined && isSilentShopifyFulfillmentRepair(channelProvider, source)) return false;
  return resolvePersistedChannelFulfillmentNotifyCustomer(channelProvider, source, value);
}

export function resolvePersistedChannelFulfillmentNotifyCustomer(
  channelProvider: string,
  source: unknown,
  value: unknown,
): boolean {
  const notifyCustomer = resolveChannelFulfillmentNotifyCustomer(value);
  // Old repair commands can already be pending/retrying at deployment. Hold
  // them before provider I/O; never mutate their stored flag or request hash.
  if (notifyCustomer && isSilentShopifyFulfillmentRepair(channelProvider, source)) {
    throw new ChannelFulfillmentRepairNotificationError(source);
  }
  return notifyCustomer;
}
