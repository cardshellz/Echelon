import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  acquireOrderEditWarehouseHold,
  releaseOrderEditWarehouseHold,
} from "../../order-edit-hold.commands";

const operationId = "00000000-0000-4000-8000-000000000001";
const dialect = new PgDialect();

describe("WMS order-edit hold ownership commands", () => {
  it.each([
    { operationId: "invalid", wmsOrderIds: [10] },
    { operationId, wmsOrderIds: [] },
    { operationId, wmsOrderIds: [0] },
    { operationId, wmsOrderIds: [10, 10] },
    { operationId, wmsOrderIds: [Number.MAX_SAFE_INTEGER + 1] },
  ])("rejects invalid ownership before executing SQL: %j", async (input) => {
    const execute = vi.fn();
    await expect(
      acquireOrderEditWarehouseHold({ execute }, input),
    ).rejects.toThrow();
    await expect(
      releaseOrderEditWarehouseHold({ execute }, input),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("binds multiple warehouse IDs as one array and fences against another owner", async () => {
    const execute = vi.fn(async (statement: SQL) => {
      const compiled = dialect.sqlToQuery(statement);
      expect(compiled.params).toEqual([operationId, [10, 11], operationId]);
      expect(compiled.sql).toContain(
        "order_edit_operation_id IS NULL OR order_edit_operation_id=",
      );
      expect(compiled.sql).not.toMatch(/SET[^;]*\bon_hold\s*=/);
      return { rows: [{ id: 10 }, { id: 11 }] };
    });
    const transaction = { execute, query: {} };
    expect(
      await acquireOrderEditWarehouseHold(
        transaction,
        { operationId, wmsOrderIds: [10, 11] },
      ),
    ).toBe(2);
  });

  it("reports a lost release fence instead of assuming success", async () => {
    const execute = vi.fn(async (statement: SQL) => {
      const compiled = dialect.sqlToQuery(statement);
      expect(compiled.params).toEqual([[10, 11], operationId]);
      expect(compiled.sql).toContain("AND order_edit_operation_id=");
      return { rows: [{ id: 10 }], rowCount: 1 };
    });
    expect(
      await releaseOrderEditWarehouseHold(
        { execute },
        { operationId, wmsOrderIds: [10, 11] },
      ),
    ).toBe(1);
  });
});
