import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const quantity = z.number().int().min(0).max(2_147_483_647);
const providerId = z.union([
  z.string().regex(/^[1-9]\d*$/),
  z.number().int().positive().safe().transform(String),
]);
const decimalMoney = z.string().regex(/^[0-9]+(?:[.][0-9]+)?$/);
const providerLine = z.object({
  id: providerId,
  sku: z.string().nullable(),
  product_id: providerId.nullable(),
  variant_id: providerId.nullable(),
  title: z.string(),
  name: z.string(),
  variant_title: z.string().nullable(),
  price: decimalMoney,
  total_discount: decimalMoney,
  discount_allocations: z.array(z.object({
    amount: decimalMoney,
    discount_application_index: quantity,
  })),
  quantity,
  current_quantity: quantity,
  fulfillable_quantity: quantity,
  requires_shipping: z.boolean(),
});
const providerOrder = z.object({
  id: providerId,
  updated_at: z.string().datetime({ offset: true }),
  financial_status: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  discount_applications: z.array(z.record(z.unknown())),
  fulfillment_status: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  refunds: z.array(z.unknown()),
  fulfillments: z.array(z.unknown()),
  line_items: z.array(providerLine).min(1),
});
export const automaticPaidReplayEvidenceSchema = z.object({
  channelId: z.number().int().positive().safe(),
  shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
  order: providerOrder,
});
export type AutomaticPaidReplayEvidence = z.infer<typeof automaticPaidReplayEvidenceSchema>;

export interface PaidReplayStoredLine {
  external_line_item_id: string | null;
  sku: string | null;
  quantity: number;
  requires_shipping: boolean | null;
  paid_quantity: number;
  authority_fulfillable_quantity: number;
  cancelled_quantity: number;
  refunded_quantity: number;
  wms_materialized_quantity: number;
  authorization_status: string;
  channel_current_quantity: number | null;
  channel_quantity_updated_at: Date | string | null;
}

export interface PaidReplayStoredOrder {
  channel_id: number;
  external_order_id: string;
  status: string;
  financial_status: string;
  fulfillment_status: string | null;
  settled: boolean;
  source_domain: string | null;
  paid_payload: unknown;
}

export type AutomaticPaidReplayDecision =
  | { eligible: true }
  | { eligible: false; reason: string };

function wholePaidOrder(order: z.infer<typeof providerOrder>): boolean {
  return order.financial_status === "paid"
    && order.cancelled_at === null
    && (order.fulfillment_status === null || order.fulfillment_status === "unfulfilled")
    && order.refunds.length === 0
    && order.fulfillments.length === 0
    && order.line_items.some(line => line.requires_shipping)
    && order.line_items.every(line => line.quantity > 0
      && line.current_quantity === line.quantity
      && line.fulfillable_quantity === (line.requires_shipping ? line.quantity : 0));
}

/** Only the missing first payment grant is automatic. Edits and partial fulfillment
 * remain in their existing recovery owners; this policy never invents quantities. */
export function decideAutomaticPaidReplay(
  stored: PaidReplayStoredOrder,
  lines: readonly PaidReplayStoredLine[],
  evidence: AutomaticPaidReplayEvidence,
): AutomaticPaidReplayDecision {
  if (!stored.settled || stored.channel_id !== evidence.channelId
    || stored.external_order_id.replace(/^gid:\/\/shopify\/Order\//, "") !== evidence.order.id
    || stored.source_domain !== evidence.shopDomain
    || stored.financial_status !== "paid"
    || !["confirmed", "pending"].includes(stored.status)
    || ![null, "unfulfilled"].includes(stored.fulfillment_status)) {
    return { eligible: false, reason: "stored_order_not_eligible" };
  }
  const receipt = providerOrder.safeParse(stored.paid_payload);
  if (!receipt.success || receipt.data.id !== evidence.order.id
    || !wholePaidOrder(receipt.data) || !wholePaidOrder(evidence.order)
    || Date.parse(receipt.data.updated_at) > Date.parse(evidence.order.updated_at)) {
    return { eligible: false, reason: "provider_order_not_eligible" };
  }
  // The canonical paid handler also normalizes catalog identities and line prices.
  // A historical replay must not overwrite changed product or commercial terms.
  if (receipt.data.currency !== evidence.order.currency
    || canonicalJson(receipt.data.discount_applications) !== canonicalJson(evidence.order.discount_applications)) {
    return { eligible: false, reason: "provider_commercial_terms_changed" };
  }
  const live = new Map(evidence.order.line_items.map(line => [line.id, line]));
  const paid = new Map(receipt.data.line_items.map(line => [line.id, line]));
  if (live.size !== evidence.order.line_items.length
    || paid.size !== receipt.data.line_items.length
    || live.size !== paid.size || lines.length !== live.size
    || new Set(lines.map(line => line.external_line_item_id)).size !== lines.length) {
    return { eligible: false, reason: "line_identity_mismatch" };
  }
  for (const line of lines) {
    const current = live.get(line.external_line_item_id ?? "");
    const original = paid.get(line.external_line_item_id ?? "");
    if (!current || !original || line.sku !== current.sku || original.sku !== current.sku
      || line.quantity !== current.quantity || original.quantity !== current.quantity
      || line.requires_shipping !== current.requires_shipping
      || original.requires_shipping !== current.requires_shipping) {
      return { eligible: false, reason: "line_identity_mismatch" };
    }
    if (canonicalJson(original) !== canonicalJson(current)) {
      return { eligible: false, reason: "provider_commercial_terms_changed" };
    }
    if (line.authorization_status !== "seen"
      || [line.paid_quantity, line.authority_fulfillable_quantity, line.cancelled_quantity,
      line.refunded_quantity, line.wms_materialized_quantity].some(value => value !== 0)
      || (line.channel_current_quantity !== null && line.channel_current_quantity !== current.quantity)) {
      return { eligible: false, reason: "line_authority_already_changed" };
    }
    if (line.channel_quantity_updated_at !== null) {
      const observedAt = new Date(line.channel_quantity_updated_at).getTime();
      if (!Number.isFinite(observedAt) || observedAt > Date.parse(evidence.order.updated_at)) {
        return { eligible: false, reason: "provider_observation_is_stale" };
      }
    }
  }
  return { eligible: true };
}
