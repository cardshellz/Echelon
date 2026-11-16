import { sql, type SQL } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";

export interface ShopifyOrderMoneySnapshot {
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
}

/**
 * Write Shopify's current order money and raw snapshot onto the OMS header,
 * but only when this snapshot is the same or newer Shopify version than the
 * one already stored.
 *
 * Why: orders/updated used to refresh addresses/status but never the money,
 * so a Shopify-admin edit (#65696: +2 units, 15% discount) left OMS showing
 * the original $70.97 while Shopify showed $68.32. Writing money from every
 * webhook would let a late, older webhook regress it, so the version check and
 * the write are one atomic statement (no read-then-write race).
 *
 * updated_at is left to the caller's header write, which always follows.
 *
 * Returns true when the snapshot was applied, false when a newer version is
 * already stored. Money is integer cents only.
 */
export async function applyVersionedShopifyOrderMoney(
  db: { execute(statement: SQL): Promise<{ rows?: unknown[]; rowCount?: number | null }> },
  input: {
    omsOrderId: number;
    channelVersion: Date;
    money: ShopifyOrderMoneySnapshot;
    rawPayload: unknown;
  },
): Promise<boolean> {
  if (!Number.isSafeInteger(input.omsOrderId) || input.omsOrderId <= 0) {
    throw new Error(`applyVersionedShopifyOrderMoney: omsOrderId must be a positive integer (got ${input.omsOrderId})`);
  }
  if (!(input.channelVersion instanceof Date) || !Number.isFinite(input.channelVersion.getTime())) {
    throw new Error("applyVersionedShopifyOrderMoney: channelVersion must be a valid date");
  }
  const money = {
    subtotalCents: readIntegerCents(input.money.subtotalCents, "subtotalCents"),
    shippingCents: readIntegerCents(input.money.shippingCents, "shippingCents"),
    taxCents: readIntegerCents(input.money.taxCents, "taxCents"),
    discountCents: readIntegerCents(input.money.discountCents, "discountCents"),
    totalCents: readIntegerCents(input.money.totalCents, "totalCents"),
  };
  const result = await db.execute(sql`
    UPDATE oms.oms_orders SET
      subtotal_cents = ${money.subtotalCents},
      shipping_cents = ${money.shippingCents},
      tax_cents = ${money.taxCents},
      discount_cents = ${money.discountCents},
      total_cents = ${money.totalCents},
      raw_payload = ${JSON.stringify(input.rawPayload)}::jsonb
    WHERE id = ${input.omsOrderId}
      AND (
        raw_payload->>'updated_at' IS NULL
        OR (raw_payload->>'updated_at')::timestamptz <= ${input.channelVersion.toISOString()}::timestamptz
      )
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}
