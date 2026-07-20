import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { createOmsService } from "../../oms.service";

const dialect = new PgDialect();

function resolvedSelect(rows: unknown[]) {
  const result = Promise.resolve(rows);
  const chain: any = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    then: result.then.bind(result),
  };
  return chain;
}

describe("OMS order flow-history query", () => {
  it("binds external order identities as scalar IN parameters", async () => {
    const selectResults = [
      [{
        id: 269119,
        channelId: 67,
        externalOrderId: "24-14885-40737",
        externalOrderNumber: "24-14885-40737",
      }],
      [],
      [],
      [{ name: "Ebay" }],
    ];
    const renderedQueries: Array<{ sql: string; params: unknown[] }> = [];
    const database = {
      select: vi.fn(() => resolvedSelect(selectResults.shift() ?? [])),
      execute: vi.fn(async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        renderedQueries.push({ sql: rendered.sql, params: rendered.params });
        return { rows: [] };
      }),
    };

    const order = await createOmsService(database).getOrderById(269119);

    expect(order?.channelName).toBe("Ebay");
    expect(renderedQueries).toHaveLength(3);
    for (const query of renderedQueries.slice(0, 2)) {
      expect(query.sql).not.toContain("ANY(");
      expect(query.sql).toContain(" IN (");
      expect(query.params).toContain("24-14885-40737");
      expect(query.params).toContain("269119");
    }
  });
});
