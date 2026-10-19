import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { hasPoInvoiceHistory, readPoInvoiceHistory } from "../../po-invoice-history.repository";

describe("locked PO invoice relationship evidence", () => {
  it.each([
    [{ hasInvoiceLinks: false, hasInvoiceLines: false }, false],
    [{ hasInvoiceLinks: true, hasInvoiceLines: false }, true],
    [{ hasInvoiceLinks: false, hasInvoiceLines: true }, true],
    [{ hasInvoiceLinks: true, hasInvoiceLines: true }, true],
  ] as const)("preserves source presence %j", async (history, expected) => {
    const tx = { execute: vi.fn(async (_query: SQL) => ({ rows: [history] })) };
    expect(hasPoInvoiceHistory(await readPoInvoiceHistory(tx, 12))).toBe(expected);
    const statement = new PgDialect().sqlToQuery(tx.execute.mock.calls[0][0]);
    expect(statement.params).toEqual([12, 12]);
    expect(statement.sql).toContain("vendor_invoice_po_links");
    expect(statement.sql).toContain("vendor_invoice_lines");
    expect(statement.sql).not.toContain("status");
  });
  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ hasInvoiceLinks: "false", hasInvoiceLines: false }] }])("fails closed on unavailable or malformed evidence %j", async ({ rows }) => {
    await expect(readPoInvoiceHistory({ execute: async () => ({ rows }) }, 12)).rejects.toThrow();
  });
  it.each([0, -1, 1.5, 2_147_483_648, NaN])("rejects invalid PO ID %s before reading", async id => {
    const tx = { execute: vi.fn() }; await expect(readPoInvoiceHistory(tx, id)).rejects.toThrow(); expect(tx.execute).not.toHaveBeenCalled();
  });
});
