import { z } from "zod";
import { costInteger } from "../../inventory/infrastructure/cost-evidence-values";
import { moneyToSafeNumber } from "../../inventory/domain/lot-cost";

const lineSchema = z
  .object({
    purchase_order_id: z.number().int().positive(),
    po_number: z.string(),
    vendor_name: z.string(),
    status: z.string(),
    expected_delivery_date: z
      .union([
        z.date(),
        z.string().refine((value) => Number.isFinite(Date.parse(value))),
      ])
      .nullable(),
    confirmed_delivery_date: z
      .union([
        z.date(),
        z.string().refine((value) => Number.isFinite(Date.parse(value))),
      ])
      .nullable(),
    eta: z
      .union([
        z.date(),
        z.string().refine((value) => Number.isFinite(Date.parse(value))),
      ])
      .nullable(),
    order_qty: z.number().int().positive().safe(),
    received_qty: z.number().int().nonnegative().safe(),
    cancelled_qty: z.number().int().nonnegative().safe(),
    total_product_cost_cents: z.union([z.number(), z.string()]),
  })
  .strict();
type ReceiptHeader = Omit<
  z.infer<typeof lineSchema>,
  "order_qty" | "received_qty" | "cancelled_qty" | "total_product_cost_cents"
>;
type PendingReceipt = ReceiptHeader & {
  pending_units: string;
  pending_lines: string;
  pending_value_cents: string;
};

/** Outstanding product value follows the exact approved product total. Round
 * each document line once to cents, then sum; rounded per-piece mirrors are not
 * a monetary source. Actual receipt and cancellation counts remain separate. */
export function projectExpectedReceipts(
  rows: readonly unknown[],
): PendingReceipt[] {
  const groups = new Map<
    number,
    { header: ReceiptHeader; units: bigint; lines: bigint; value: bigint }
  >();
  for (const raw of rows) {
    const {
      order_qty,
      received_qty,
      cancelled_qty,
      total_product_cost_cents,
      ...header
    } = lineSchema.parse(raw);
    const pieces = BigInt(
      Math.max(0, order_qty - received_qty - cancelled_qty),
    );
    const total = BigInt(
      costInteger(total_product_cost_cents, "PO product total"),
    );
    const quantity = BigInt(order_qty);
    const cents =
      (total * pieces * BigInt(2) + quantity) / (quantity * BigInt(2));
    const group = groups.get(header.purchase_order_id) ?? {
      header,
      units: BigInt(0),
      lines: BigInt(0),
      value: BigInt(0),
    };
    group.units += pieces;
    group.lines++;
    group.value += cents;
    groups.set(header.purchase_order_id, group);
  }
  return [...groups.values()].map(({ header, units, lines, value }) => {
    for (const amount of [units, lines, value])
      moneyToSafeNumber(amount, "expected receipt report total");
    return {
      ...header,
      pending_units: String(units),
      pending_lines: String(lines),
      pending_value_cents: String(value),
    };
  });
}
