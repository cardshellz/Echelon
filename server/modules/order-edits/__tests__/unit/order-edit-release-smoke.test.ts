import { describe, expect, it, vi } from "vitest";
import { runOrderEditReadSmoke } from "../../infrastructure/order-edit-release-smoke";

type Reply = { rows: unknown[] } | Error;

/** A pool whose clients answer by matching the SQL text they are sent. */
function fakePool(answer: (sql: string) => Reply) {
  const statements: string[] = [];
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        const reply = answer(sql);
        if (reply instanceof Error) throw reply;
        return reply;
      }),
      release,
    })),
  };
  return { pool: pool as never, statements, release };
}

const newestOrder = (sql: string) => sql.includes("ORDER BY id DESC LIMIT 1");
const sourceOrder = (sql: string) => sql.includes("FROM oms.oms_orders WHERE id=$1");

describe("order edit release smoke", () => {
  it("skips when the database has no orders", async () => {
    const h = fakePool(() => ({ rows: [] }));
    await expect(runOrderEditReadSmoke(h.pool)).resolves.toEqual({
      outcome: "skipped",
      reason: "no_orders",
    });
    expect(h.statements).toHaveLength(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("passes after running the inspection read-only against the newest order", async () => {
    const h = fakePool((sql) =>
      newestOrder(sql)
        ? { rows: [{ id: 7 }] }
        : sourceOrder(sql)
          ? { rows: [{ id: 7, channel_id: 1 }] }
          : { rows: [] },
    );
    await expect(runOrderEditReadSmoke(h.pool)).resolves.toEqual({
      outcome: "passed",
      omsOrderId: 7,
    });
    expect(h.statements).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(h.statements.some((sql) => sql.includes("FROM wms.orders wo"))).toBe(true);
    expect(h.statements.some((sql) => /\b(INSERT|UPDATE|DELETE)\b/.test(sql) && !sql.includes("SELECT"))).toBe(false);
    expect(h.statements.at(-1)).toBe("COMMIT");
  });

  it("fails the release when the inspection SQL is rejected by the database", async () => {
    const rejected = Object.assign(
      new Error('invalid input value for enum wms.shipment_status: "delivered"'),
      { code: "22P02" },
    );
    const h = fakePool((sql) =>
      newestOrder(sql)
        ? { rows: [{ id: 7 }] }
        : sourceOrder(sql)
          ? { rows: [{ id: 7, channel_id: 1 }] }
          : sql.includes("FROM wms.orders wo")
            ? rejected
            : { rows: [] },
    );
    await expect(runOrderEditReadSmoke(h.pool)).rejects.toBe(rejected);
    expect(h.statements.at(-1)).toBe("ROLLBACK");
  });

  it("treats a business refusal as proof the SQL ran, not a release failure", async () => {
    // The newest order vanished between the two reads: inspection refuses it.
    const h = fakePool((sql) =>
      newestOrder(sql) ? { rows: [{ id: 7 }] } : { rows: [] },
    );
    await expect(runOrderEditReadSmoke(h.pool)).resolves.toEqual({
      outcome: "refused",
      omsOrderId: 7,
      code: "ORDER_EDIT_ORDER_MISSING",
    });
  });
});
