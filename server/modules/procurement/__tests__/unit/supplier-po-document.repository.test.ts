import { describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { purchaseOrders, purchaseOrderLines, vendors } from "@shared/schema/procurement.schema";
import { echelonSettings, warehouses } from "@shared/schema/warehouse.schema";
import {
  loadSupplierPoDocumentSource,
  type SupplierPoDocumentDatabase,
} from "../../supplier-po-document.repository";
import { supplierDocumentSource } from "../fixtures/supplier-po-document.fixture";

type StoredRow = Record<string, unknown>;
type Statement = { text: string; params: unknown[] };
const companyKeys = ["company_name", "company_address", "company_city", "company_state", "company_postal_code", "company_country"];
const tables: PgTable[] = [purchaseOrders, purchaseOrderLines, vendors, warehouses, echelonSettings];

/** Exercise the real Drizzle SQL builder and row decoder against an in-memory
 * driver. No application DB import, pool or network connection is involved. */
function setup(options: { missing?: "purchase_orders" | "vendors" | "warehouses"; warehouseId?: number | null; failTable?: string } = {}) {
  const source = supplierDocumentSource();
  const stored: Record<string, StoredRow[]> = {
    purchase_orders: [{ ...source.po, warehouseId: options.warehouseId === undefined ? source.po.warehouseId : options.warehouseId }],
    purchase_order_lines: source.lines,
    vendors: [source.vendor],
    warehouses: [source.warehouse],
    echelon_settings: [
      ...companyKeys.map((key) => ({ key, value: `setting:${key}` })),
      { key: "private_access_token", value: "PRIVATE_SETTING_SECRET" },
    ],
  };
  if (options.missing) stored[options.missing] = [];
  const statements: Statement[] = [];
  const failure = new Error("Synthetic database failure");
  const query = vi.fn(async (config: { text: string }, params: unknown[] = []) => {
    const text = config.text;
    statements.push({ text, params });
    if (!text.startsWith("select ")) return { rows: [] };
    const match = /^select (.+) from "[^"]+"\."([^"]+)"/.exec(text);
    if (!match) throw new Error(`Unexpected fixture SELECT: ${text}`);
    const [, projection, tableName] = match;
    if (options.failTable === tableName) throw failure;
    const table = tables.find((candidate) => getTableName(candidate) === tableName);
    if (!table) throw new Error(`Unexpected fixture table: ${tableName}`);
    const propertyByColumn = new Map(Object.entries(getTableColumns(table)).map(([property, column]) => [column.name, property]));
    const columns = [...projection.matchAll(/"([^"]+)"/g)].map((column) => column[1]);
    const rows = tableName === "echelon_settings"
      ? stored[tableName].filter((row) => params.includes(row.key))
      : stored[tableName];
    return { rows: rows.map((row) => columns.map((column) => {
      const property = propertyByColumn.get(column);
      if (!property) throw new Error(`Unexpected projected column: ${column}`);
      const value = row[property] ?? null;
      return value instanceof Date ? value.toISOString() : value;
    })) };
  });
  // The fake implements only the driver query boundary used by Drizzle.
  const database = drizzle({ query } as never) as unknown as SupplierPoDocumentDatabase;
  return { database, statements, failure };
}

describe("supplier PO document read boundary", () => {
  it("uses one read-only repeatable-read transaction and allowlists public fields/settings", async () => {
    const { database, statements } = setup();
    const source = await loadSupplierPoDocumentSource(database, 1);
    expect(statements[0].text).toBe("begin isolation level repeatable read read only");
    expect(statements.at(-1)?.text).toBe("commit");
    const reads = statements.filter((statement) => statement.text.startsWith("select "));
    expect(reads).toHaveLength(5);
    expect(statements.every((statement) => /^(select |begin |commit$)/.test(statement.text))).toBe(true);
    expect(reads[0].params).toEqual([1, 1]);
    expect(reads[0].text).toContain('where "procurement"."purchase_orders"."id" = $1');
    expect(reads[1].text).toContain('order by "procurement"."purchase_order_lines"."line_number" asc, "procurement"."purchase_order_lines"."id" asc');
    expect(reads[1].text).not.toContain("cancelled");
    expect(reads[4].text).toContain('"warehouse"."echelon_settings"');
    expect(reads[4].params).toEqual(companyKeys);
    expect(reads.map((statement) => statement.text).join("\n")).not.toMatch(/internal_notes|approval_notes|metadata|"notes"/);
    expect(source.po.poNumber).toBe("PO-DOCUMENT-001");
    expect(source.po.shippingCostCents).toBe(0);
    expect(source.lines[0].quotedUnitCostMills).toBe(1234500);
    expect(source.lines[0].pricingRemainderMills).toBe(0);
    expect(source.vendor.name).toBe("Synthetic supplier");
    expect(source.warehouse?.address).toBe("3 Receiving Road");
    expect(source.companyName).toBe("setting:company_name");
    expect(JSON.stringify(source)).not.toContain("PRIVATE_");
    expect(source.po).not.toHaveProperty("internalNotes");
    expect(source.lines[0]).not.toHaveProperty("notes");
  });

  it("does not invent or read a default warehouse when the PO has none", async () => {
    const { database, statements } = setup({ warehouseId: null });
    const source = await loadSupplierPoDocumentSource(database, 1);
    expect(source.warehouse).toBeUndefined();
    expect(statements.some((statement) => statement.text.includes('from "warehouse"."warehouses"'))).toBe(false);
  });

  it.each([
    ["purchase_orders", "PURCHASE_ORDER_NOT_FOUND", 404],
    ["vendors", "INVALID_SUPPLIER_DOCUMENT_SOURCE", 409],
    ["warehouses", "INVALID_SUPPLIER_DOCUMENT_SOURCE", 409],
  ] as const)("fails when the referenced %s record is unavailable", async (missing, code, statusCode) => {
    const { database, statements } = setup({ missing });
    await expect(loadSupplierPoDocumentSource(database, 1)).rejects.toMatchObject({ code, statusCode });
    expect(statements.at(-1)?.text).toBe("rollback");
    expect(statements.some((statement) => statement.text === "commit")).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects invalid PO id %s before opening a transaction", async (id) => {
    const { database, statements } = setup();
    await expect(loadSupplierPoDocumentSource(database, id)).rejects.toMatchObject({ code: "INVALID_SUPPLIER_DOCUMENT_SOURCE" });
    expect(statements).toEqual([]);
  });

  it("propagates a failed read without returning partial supplier data", async () => {
    const { database, statements, failure } = setup({ failTable: "purchase_order_lines" });
    await expect(loadSupplierPoDocumentSource(database, 1)).rejects.toThrow("Synthetic database failure");
    expect(statements.at(-1)?.text).toBe("rollback");
    expect(statements.some((statement) => statement.text === "commit")).toBe(false);
    expect(failure.message).toBe("Synthetic database failure");
  });
});
