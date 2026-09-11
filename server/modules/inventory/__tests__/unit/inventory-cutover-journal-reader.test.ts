import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readInventoryCutoverReconstruction } from "../../infrastructure/inventory-cutover-reconstruction.reader";
import { MAX_CUTOVER_JOURNAL_ROWS } from "../../domain/inventory-cutover-journal-evidence";

vi.mock("../../infrastructure/inventory-cutover-encumbrance.repository", () => ({
  captureInventoryCutoverEncumbranceAfterAdmission: vi.fn().mockResolvedValue({ buildReservations: [], canonicalResources: [] }),
}));

function client(journals: unknown[]) {
  let offset = 0;
  const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("FETCH") ? journals.slice(offset,(offset+=500))
    : sql.includes("FROM inventory.availability_claims claim") ? [{ count: "0", digest: "a".repeat(64) }] : [] }));
  return { query, client: { query } as unknown as PoolClient };
}
describe("single-snapshot compact inventory journal census", () => {
  it("uses one bounded statement with exact FK joins, no paging or returned raw JSON", async () => {
    const test = client([]);
    expect(await readInventoryCutoverReconstruction(test.client)).toMatchObject({ journals: [] });
    const captures = test.query.mock.calls.filter(([sql]) => sql.includes("FROM inventory.inventory_transactions journal"));
    expect(captures).toHaveLength(1);
    expect(captures[0]).toEqual([expect.any(String), [MAX_CUTOVER_JOURNAL_ROWS + 1]]);
    const sql = captures[0][0];
    expect(sql).toContain("LEFT JOIN wms.outbound_shipments direct_shipment ON direct_shipment.id=journal.shipment_id");
    expect(sql).toContain("LEFT JOIN wms.outbound_shipment_items source ON source.id=journal.shipment_item_id");
    expect(sql).toContain('AS "journalHash"'); expect(sql).toContain('AS "linkHash"');
    expect(sql).not.toMatch(/\bOFFSET\b|\bid\s*>\s*\$|AS\s+evidence\b|AS\s+payload\b/i);
    expect(sql).toContain("journal.voided_at IS NULL");
    expect(sql).toContain("NOT LIKE 'availability_claim%'");
  });
  it("rejects invalid fetched evidence before claims or partial ownership can be returned", async () => {
    const test = client([null]);
    await expect(readInventoryCutoverReconstruction(test.client)).rejects.toThrow();
    expect(test.query.mock.calls.some(([sql]) => sql.includes("FROM inventory.availability_claims claim"))).toBe(false);
  });
});
