/**
 * Branded ID types for cross-system identifier safety.
 *
 * Purpose (per refactor plan v2 §4.8): multiple IDs flow through the
 * OMS ↔ WMS ↔ ShipStation ↔ Shopify chain — Shopify numeric IDs, Shopify
 * GIDs, OMS primary keys, WMS primary keys, shipment IDs, ShipStation
 * order IDs, Shopify fulfillment IDs. They're all numbers/strings at the
 * wire level, so the compiler can't catch "I passed a Shopify numeric ID
 * where an OMS primary key was expected". Nominal branding closes that
 * hole without runtime cost.
 *
 * Usage:
 *   import { OmsOrderId, toOmsOrderId } from "@shared/types/ids";
 *   const id: OmsOrderId = toOmsOrderId(row.id);   // asserts + tags
 *   acceptOnlyOmsOrderIds(id);                      // type-checked
 *
 * Guard constructors (`toXxx`) validate with Zod (coding-standards rule
 * #4) and throw `RangeError` on bad input. Use the `isXxx` variants for
 * non-throwing checks.
 *
 * All brands are structural-only (no runtime representation change), so
 * serialization to/from JSON / SQL is identity.
 */

import { z } from "zod";

// ─── Brand helper ─────────────────────────────────────────────────────
//
// Private symbol key `__brand` keeps the tag out of runtime objects
// while still forcing nominal equivalence at the type level.

declare const BrandSymbol: unique symbol;
type Brand<T, B extends string> = T & { readonly [BrandSymbol]: B };

// ─── Primitive ID brand definitions ──────────────────────────────────

/**
 * Shopify numeric order id, e.g. `5432109876543` — appears as a string
 * in webhook payloads (`payload.order_id`) but represents an unsigned
 * integer. We model it as `string` because Shopify numeric IDs can exceed
 * `Number.MAX_SAFE_INTEGER` at scale and must not be coerced to number.
 */
export type ShopifyNumericId = Brand<string, "ShopifyNumericId">;

/**
 * Shopify Admin GraphQL global ID, e.g.
 * `gid://shopify/Order/5432109876543`. Distinct type from the numeric
 * form so a webhook-path caller can't accidentally compare the two.
 */
export type ShopifyGid = Brand<string, "ShopifyGid">;

/**
 * `oms.oms_orders.id` — our OMS primary key (BIGINT at the DB level,
 * modeled as `number` because we never ingest more than 2^53 orders
 * and all callers need integer ops).
 */
export type OmsOrderId = Brand<number, "OmsOrderId">;

/**
 * `oms.oms_order_lines.id` — OMS line item primary key.
 */
export type OmsOrderLineId = Brand<number, "OmsOrderLineId">;

/**
 * `wms.orders.id` — WMS order primary key.
 */
export type WmsOrderId = Brand<number, "WmsOrderId">;

/**
 * `wms.outbound_shipments.id` — WMS shipment primary key. Becomes the
 * primary ShipStation connection point in v2 (invariant #3).
 */
export type WmsShipmentId = Brand<number, "WmsShipmentId">;

/**
 * ShipStation's `orderId` (their internal PK, integer). Distinct from
 * `orderKey` which is a string we control (e.g. `echelon-wms-shp-42`).
 */
export type ShipStationOrderId = Brand<number, "ShipStationOrderId">;

/**
 * Shopify Admin fulfillment id — string, returned from
 * `fulfillmentCreateV2` on the Admin GQL API.
 */
export type ShopifyFulfillmentId = Brand<string, "ShopifyFulfillmentId">;

// ─── Zod parsers (runtime validation at boundaries) ──────────────────

const nonEmptyString = z.string().trim().min(1);
const positiveInt = z.number().int().positive();

/**
 * Accepts Shopify numeric IDs as a non-empty string of digits. Rejects
 * leading "gid://" or anything non-numeric so the caller gets a clear
 * error at the boundary (coding-standards rule #5: structured errors).
 */
export const ShopifyNumericIdSchema = nonEmptyString
  .regex(/^[0-9]+$/, "ShopifyNumericId must be digits only");

/**
 * Accepts Shopify Admin GIDs of the form `gid://shopify/<Resource>/<id>`.
 */
export const ShopifyGidSchema = nonEmptyString
  .regex(
    /^gid:\/\/shopify\/[A-Za-z][A-Za-z0-9]*\/[0-9]+$/,
    "ShopifyGid must match gid://shopify/<Resource>/<numericId>",
  );

export const OmsOrderIdSchema = positiveInt;
export const OmsOrderLineIdSchema = positiveInt;
export const WmsOrderIdSchema = positiveInt;
export const WmsShipmentIdSchema = positiveInt;
export const ShipStationOrderIdSchema = positiveInt;
export const ShopifyFulfillmentIdSchema = nonEmptyString;

// ─── Guard constructors ──────────────────────────────────────────────
//
// Use at every boundary where an untyped primitive enters the system
// (webhook bodies, DB reads, URL params). Throws with a structured
// message on mismatch.

function makeGuard<Raw, Brand>(
  schema: z.ZodType<Raw>,
  label: string,
): (value: unknown) => Brand {
  return (value: unknown): Brand => {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new RangeError(
        `${label}: invalid value ${JSON.stringify(value)} — ${result.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    return result.data as unknown as Brand;
  };
}

export const toShopifyNumericId = makeGuard<string, ShopifyNumericId>(
  ShopifyNumericIdSchema,
  "toShopifyNumericId",
);

export const toShopifyGid = makeGuard<string, ShopifyGid>(
  ShopifyGidSchema,
  "toShopifyGid",
);

export const toOmsOrderId = makeGuard<number, OmsOrderId>(
  OmsOrderIdSchema,
  "toOmsOrderId",
);

export const toOmsOrderLineId = makeGuard<number, OmsOrderLineId>(
  OmsOrderLineIdSchema,
  "toOmsOrderLineId",
);

export const toWmsOrderId = makeGuard<number, WmsOrderId>(
  WmsOrderIdSchema,
  "toWmsOrderId",
);

export const toWmsShipmentId = makeGuard<number, WmsShipmentId>(
  WmsShipmentIdSchema,
  "toWmsShipmentId",
);

export const toShipStationOrderId = makeGuard<number, ShipStationOrderId>(
  ShipStationOrderIdSchema,
  "toShipStationOrderId",
);

export const toShopifyFulfillmentId = makeGuard<string, ShopifyFulfillmentId>(
  ShopifyFulfillmentIdSchema,
  "toShopifyFulfillmentId",
);

// ─── Non-throwing predicates ─────────────────────────────────────────

export const isShopifyNumericId = (v: unknown): v is ShopifyNumericId =>
  ShopifyNumericIdSchema.safeParse(v).success;

export const isShopifyGid = (v: unknown): v is ShopifyGid =>
  ShopifyGidSchema.safeParse(v).success;

export const isOmsOrderId = (v: unknown): v is OmsOrderId =>
  OmsOrderIdSchema.safeParse(v).success;

export const isWmsOrderId = (v: unknown): v is WmsOrderId =>
  WmsOrderIdSchema.safeParse(v).success;

export const isWmsShipmentId = (v: unknown): v is WmsShipmentId =>
  WmsShipmentIdSchema.safeParse(v).success;

export const isShipStationOrderId = (v: unknown): v is ShipStationOrderId =>
  ShipStationOrderIdSchema.safeParse(v).success;

export const isShopifyFulfillmentId = (v: unknown): v is ShopifyFulfillmentId =>
  ShopifyFulfillmentIdSchema.safeParse(v).success;
