/**
 * Channel Order Intake Port (`P3.1`)
 *
 * Canonical boundary contract and Zod schemas for ingesting commercial orders,
 * cancellations, and refunds from any external sales channel into OMS.
 *
 * Every registered `ChannelOrderAdapter` validates its normalized output
 * through the Zod boundary schemas here before OMS persistence or WMS routing.
 */

import { z } from "zod";

const nonEmptyTrimmedString = z.string().trim().min(1);
const boundedIdString = z.string().trim().min(1).max(128);
const providerKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
const safeIntCents = z.number().int().safe();
const nonNegativeIntCents = z.number().int().nonnegative().safe();
const positiveIntQty = z.number().int().positive().max(2_147_483_647);
const nonNegativeIntQty = z.number().int().nonnegative().max(2_147_483_647);

export const channelOrderShippingAddressSchema = z.object({
  name: z.string().nullable().default(null),
  company: z.string().nullable().optional().default(null),
  address1: z.string().nullable().default(null),
  address2: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  province: z.string().nullable().default(null),
  zip: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
});

export const channelIntakeOrderLineSchema = z.object({
  externalLineItemId: boundedIdString,
  externalProductId: z.string().nullable().optional().default(null),
  externalVariantId: z.string().nullable().optional().default(null),
  sku: z.string().nullable().default(null),
  title: z.string().min(1),
  name: z.string().nullable().optional().default(null),
  variantTitle: z.string().nullable().optional().default(null),
  quantity: positiveIntQty,
  currentQuantity: nonNegativeIntQty.nullable().optional(),
  fulfillableQuantity: nonNegativeIntQty.nullable().optional(),
  paidPriceCents: safeIntCents,
  retailPriceCents: safeIntCents.optional(),
  discountCents: safeIntCents.default(0),
  taxCents: nonNegativeIntCents.default(0),
  totalCents: safeIntCents,
  requiresShipping: z.boolean().optional(),
  fulfillmentProvider: z.string().nullable().optional().default(null),
});

export const channelIntakeOrderSchema = z.object({
  externalOrderId: boundedIdString,
  externalOrderNumber: nonEmptyTrimmedString.optional(),
  channelId: z.number().int().positive().safe(),
  source: providerKeySchema,
  status: z
    .enum(["pending", "confirmed", "cancelled", "shipped", "partially_shipped"])
    .default("confirmed"),
  financialStatus: z.string().trim().min(1).nullable().default("paid"),
  fulfillmentStatus: z.string().trim().min(1).nullable().default("unfulfilled"),
  customerEmail: z.string().nullable().default(null),
  customerName: z.string().nullable().default(null),
  customerPhone: z.string().nullable().optional().default(null),
  /** Explicit null allowed for guest checkouts (e.g. Shopify guest orders). */
  externalCustomerId: z.string().nullable().optional(),
  shippingAddress: channelOrderShippingAddressSchema.nullable().default(null),
  shippingMethod: z.string().nullable().optional().default(null),
  shippingMethodCode: z.string().nullable().optional().default(null),
  shippingServiceLevel: z
    .enum(["standard", "expedited", "overnight"])
    .optional(),
  channelShipByDate: z.union([z.date(), z.string()]).nullable().optional(),
  lineItems: z.array(channelIntakeOrderLineSchema),
  subtotalCents: safeIntCents,
  grossSubtotalCents: safeIntCents.optional(),
  taxCents: nonNegativeIntCents,
  shippingCents: safeIntCents,
  discountCents: safeIntCents,
  totalCents: safeIntCents,
  currency: z
    .string()
    .trim()
    .transform((c) => c.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/)),
  notes: z.string().nullable().default(null),
  tags: z.array(z.string()).nullable().default(null),
  riskLevel: z.string().nullable().optional().default(null),
  riskScore: z.string().nullable().optional().default(null),
  riskRecommendation: z.string().nullable().optional().default(null),
  riskFacts: z.unknown().optional(),
  orderDate: z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid orderDate"),
  channelUpdatedAt: z.union([z.date(), z.string()]).nullable().optional(),
  sourceTopic: z.string().trim().min(1).optional(),
  sourceEventId: z.string().nullable().optional(),
  sourceInboxId: z.number().int().positive().nullable().optional(),
  rawPayload: z.unknown().optional(),
});

export const channelIntakeCancelSchema = z.object({
  externalOrderId: boundedIdString,
  channelId: z.number().int().positive().safe(),
  source: providerKeySchema,
  reason: z.string().nullable().default(null),
  cancelledAt: z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid cancelledAt"),
  lineItems: z
    .array(
      z.object({
        externalLineItemId: boundedIdString,
        quantity: positiveIntQty,
      }),
    )
    .nullable()
    .default(null),
  rawPayload: z.unknown().optional(),
});

export const channelIntakeRefundSchema = z.object({
  externalOrderId: boundedIdString,
  externalRefundId: z.string().trim().min(1).nullable().default(null),
  channelId: z.number().int().positive().safe(),
  source: providerKeySchema,
  financialStatus: z.enum(["refunded", "partially_refunded"]),
  refundAmountCents: nonNegativeIntCents,
  refundedAt: z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid refundedAt"),
  lineItems: z
    .array(
      z.object({
        externalLineItemId: boundedIdString,
        quantity: nonNegativeIntQty,
        restockType: z.string().nullable().optional().default(null),
      }),
    )
    .default([]),
  rawPayload: z.unknown().optional(),
});

export type ValidatedChannelOrder = z.output<typeof channelIntakeOrderSchema>;
export type ValidatedChannelOrderInput = z.input<typeof channelIntakeOrderSchema>;
export type ValidatedChannelOrderLine = z.output<typeof channelIntakeOrderLineSchema>;
export type ValidatedChannelCancelEvent = z.output<typeof channelIntakeCancelSchema>;
export type ValidatedChannelCancelInput = z.input<typeof channelIntakeCancelSchema>;
export type ValidatedChannelRefundEvent = z.output<typeof channelIntakeRefundSchema>;
export type ValidatedChannelRefundInput = z.input<typeof channelIntakeRefundSchema>;

export class ChannelOrderBoundaryValidationError extends Error {
  readonly code = "CHANNEL_ORDER_BOUNDARY_INVALID" as const;

  constructor(
    readonly providerKey: string,
    readonly issues: readonly z.ZodIssue[],
    message?: string,
  ) {
    super(
      message ??
        `[${providerKey}] Channel intake boundary validation failed: ${issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ")}`,
    );
    this.name = "ChannelOrderBoundaryValidationError";
  }
}

export function parseValidatedChannelOrder(
  providerKey: string,
  candidate: ValidatedChannelOrderInput,
): ValidatedChannelOrder {
  const parsed = channelIntakeOrderSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChannelOrderBoundaryValidationError(providerKey, parsed.error.issues);
  }
  return parsed.data;
}

export function parseValidatedChannelCancel(
  providerKey: string,
  candidate: ValidatedChannelCancelInput,
): ValidatedChannelCancelEvent {
  const parsed = channelIntakeCancelSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChannelOrderBoundaryValidationError(providerKey, parsed.error.issues);
  }
  return parsed.data;
}

export function parseValidatedChannelRefund(
  providerKey: string,
  candidate: ValidatedChannelRefundInput,
): ValidatedChannelRefundEvent {
  const parsed = channelIntakeRefundSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ChannelOrderBoundaryValidationError(providerKey, parsed.error.issues);
  }
  return parsed.data;
}

export interface ChannelWebhookVerifyInput {
  rawBody?: Buffer | string | null;
  parsedBody?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

export type ChannelWebhookVerifyResult =
  | { ok: true; bypassed?: boolean }
  | {
      ok: false;
      statusCode: 400 | 401 | 403 | 500 | 503;
      code: string;
      message: string;
    };

export interface ChannelOrderNormalizeContext {
  channelId: number;
  sourceTopic?: string;
  sourceEventId?: string | null;
  sourceInboxId?: number | null;
  observedAt?: Date;
}

/**
 * Canonical Channel Order Intake Adapter (`P3.1`).
 *
 * A new channel integrates into OMS order ingestion by implementing this
 * single adapter interface, registering a `channels` row, and passing the
 * shared adapter-conformance suite.
 */
export interface ChannelOrderAdapter {
  readonly adapterName: string;
  readonly providerKey: string;

  verifyWebhook(
    input: ChannelWebhookVerifyInput,
  ): Promise<ChannelWebhookVerifyResult> | ChannelWebhookVerifyResult;

  normalizeOrder(
    rawPayload: unknown,
    context: ChannelOrderNormalizeContext,
  ): ValidatedChannelOrder;

  normalizeCancel(
    rawPayload: unknown,
    context: ChannelOrderNormalizeContext,
  ): ValidatedChannelCancelEvent | null;

  normalizeRefund(
    rawPayload: unknown,
    context: ChannelOrderNormalizeContext,
  ): ValidatedChannelRefundEvent | null;
}

export class ChannelOrderAdapterRegistry {
  private readonly adapters = new Map<string, ChannelOrderAdapter>();

  register(adapter: ChannelOrderAdapter): void {
    if (this.adapters.has(adapter.providerKey)) {
      throw new Error(
        `ChannelOrderAdapter already registered for provider "${adapter.providerKey}"`,
      );
    }
    this.adapters.set(adapter.providerKey, adapter);
  }

  get(providerKey: string): ChannelOrderAdapter | undefined {
    return this.adapters.get(providerKey);
  }

  getOrThrow(providerKey: string): ChannelOrderAdapter {
    const adapter = this.adapters.get(providerKey);
    if (!adapter) {
      throw new Error(
        `No ChannelOrderAdapter registered for provider "${providerKey}"`,
      );
    }
    return adapter;
  }

  has(providerKey: string): boolean {
    return this.adapters.has(providerKey);
  }

  getAll(): ChannelOrderAdapter[] {
    return Array.from(this.adapters.values());
  }

  getRegisteredProviders(): string[] {
    return Array.from(this.adapters.keys());
  }
}
