/**
 * Unit tests for backfillOpenOrderItemBinAssignment (2026-07 ESS-TOP incident).
 *
 * Invariants protected:
 *   1. Narrow blast radius — the UPDATE must only touch items that are still
 *      UNASSIGNED, still unpicked, on non-terminal orders, matched strictly
 *      by SKU. It must never move an item already pointing at a real bin.
 *   2. No-op guards — UNASSIGNED/blank bin codes and missing SKUs return 0
 *      without executing SQL.
 *   3. Best-effort contract — a DB error is swallowed (returns 0, no throw),
 *      so a bin assignment can never fail because of the backfill.
 */

import { describe, it, expect, vi } from "vitest";
import { backfillOpenOrderItemBinAssignment } from "../../infrastructure/warehouse.repository";

// Flatten a drizzle sql`` template to raw text (same approach as the OMS
// push-shipment tests) so we can assert on the query's guards.
function sqlTextOf(query: any): string {
  const chunks: unknown[] = query?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && Array.isArray((c as any).value)) {
        return (c as any).value.join("");
      }
      return "";
    })
    .join("");
}

function makeTx(result: any = { rowCount: 3 }) {
  const execute = vi.fn(async (_q: any) => result);
  return { execute } as any;
}

describe("backfillOpenOrderItemBinAssignment :: no-op guards", () => {
  it("returns 0 and runs no SQL for an UNASSIGNED bin code", async () => {
    const tx = makeTx();
    const n = await backfillOpenOrderItemBinAssignment(
      { sku: "ABC-1", locationCode: "UNASSIGNED" }, tx,
    );
    expect(n).toBe(0);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("returns 0 and runs no SQL for a blank/U bin code", async () => {
    const tx = makeTx();
    expect(await backfillOpenOrderItemBinAssignment({ sku: "ABC-1", locationCode: "" }, tx)).toBe(0);
    expect(await backfillOpenOrderItemBinAssignment({ sku: "ABC-1", locationCode: "u" }, tx)).toBe(0);
    expect(await backfillOpenOrderItemBinAssignment({ sku: "ABC-1", locationCode: null }, tx)).toBe(0);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("returns 0 and runs no SQL when the assignment has no SKU", async () => {
    const tx = makeTx();
    const n = await backfillOpenOrderItemBinAssignment(
      { sku: null, locationCode: "F-03" }, tx,
    );
    expect(n).toBe(0);
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

describe("backfillOpenOrderItemBinAssignment :: the UPDATE", () => {
  it("stamps open UNASSIGNED items by SKU and returns the row count", async () => {
    const tx = makeTx({ rowCount: 4 });
    const n = await backfillOpenOrderItemBinAssignment(
      { sku: "ess-top-std-slv-clr-c1000", locationCode: "f-03", zone: "F" }, tx,
    );
    expect(n).toBe(4);
    expect(tx.execute).toHaveBeenCalledTimes(1);

    const text = sqlTextOf(tx.execute.mock.calls[0][0]);
    // Only still-unassigned items…
    expect(text).toContain("oi.location IS NULL OR oi.location IN ('UNASSIGNED', 'U')");
    // …that are still unpicked…
    expect(text).toContain("oi.picked_quantity < oi.quantity");
    // …on non-terminal orders…
    expect(text).toContain("o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')");
    // …matched strictly by SKU.
    expect(text).toContain("UPPER(oi.sku) =");
    expect(text).not.toContain("product_id");
  });

  it("uppercases bin code, zone, and sku params", async () => {
    const tx = makeTx({ rowCount: 1 });
    await backfillOpenOrderItemBinAssignment(
      { sku: "abc-1", locationCode: "f-03", zone: "f" }, tx,
    );
    const query: any = tx.execute.mock.calls[0][0];
    const params = (query?.queryChunks ?? []).filter(
      (c: unknown) => typeof c === "object" && c !== null && "value" in (c as any) === false,
    );
    // Drizzle stores bound params as non-string chunks; assert via JSON of the template
    const bound = JSON.stringify(query);
    expect(bound).toContain("F-03");
    expect(bound).toContain("ABC-1");
    expect(bound).toContain("\"F\"");
  });

  it("derives the zone from the bin code when zone is missing", async () => {
    const tx = makeTx({ rowCount: 1 });
    await backfillOpenOrderItemBinAssignment({ sku: "ABC-1", locationCode: "G-11" }, tx);
    expect(JSON.stringify(tx.execute.mock.calls[0][0])).toContain("\"G\"");
  });
});

describe("backfillOpenOrderItemBinAssignment :: best-effort contract", () => {
  it("swallows DB errors and returns 0 (an assignment must never fail on backfill)", async () => {
    const execute = vi.fn(async () => { throw new Error("boom"); });
    const n = await backfillOpenOrderItemBinAssignment(
      { sku: "ABC-1", locationCode: "F-03" }, { execute } as any,
    );
    expect(n).toBe(0);
  });

  it("returns 0 when the driver reports no rowCount", async () => {
    const tx = makeTx({});
    const n = await backfillOpenOrderItemBinAssignment(
      { sku: "ABC-1", locationCode: "F-03" }, tx,
    );
    expect(n).toBe(0);
  });
});
