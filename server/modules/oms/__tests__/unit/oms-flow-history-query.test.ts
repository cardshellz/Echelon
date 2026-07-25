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
  it("uses indexed source-inbox lineage instead of scanning webhook payload JSON", async () => {
    const selectResults = [
      [{
        id: 269119,
        channelId: 67,
        externalOrderId: "24-14885-40737",
        externalOrderNumber: "24-14885-40737",
      }],
      [{
        id: 10,
        authoritySourceInboxId: 79377,
        authorizedByEventId: "webhook_inbox:79370",
      }],
      [{
        id: 20,
        eventType: "tracking_pushed",
        details: { sourceInboxId: 79378 },
        createdAt: new Date("2026-07-19T12:00:00Z"),
      }],
      [{ name: "Ebay" }],
    ];
    const renderedQueries: Array<{ sql: string; params: unknown[] }> = [];
    const database = {
      select: vi.fn(() => resolvedSelect(selectResults.shift() ?? [])),
      execute: vi.fn(async (query: any) => {
        const rendered = dialect.sqlToQuery(query);
        renderedQueries.push({ sql: rendered.sql, params: rendered.params });
        if (rendered.sql.includes("channel_order_intakes")) {
          return { rows: [{ source_inbox_id: 79379 }] };
        }
        if (rendered.sql.includes("webhook_inbox")) {
          return {
            rows: [{
              id: 79377,
              provider: "ebay",
              topic: "order",
              event_id: "evt-1",
              status: "succeeded",
              attempts: 1,
              last_error: null,
              processed_at: new Date("2026-07-19T11:00:00Z"),
            }],
          };
        }
        return { rows: [] };
      }),
    };

    const flowHistory = await createOmsService(database).getOrderFlowHistoryById(269119);

    expect(flowHistory).toHaveLength(2);
    expect(renderedQueries).toHaveLength(3);
    expect(renderedQueries[0].sql).toContain("channel_order_intakes");
    expect(renderedQueries[0].sql).toContain("oms_order_id");
    expect(renderedQueries[1].sql).toContain("webhook_inbox");
    expect(renderedQueries[1].sql).toContain("WHERE id IN (");
    expect(renderedQueries[2].sql).toContain("webhook_retry_queue");
    expect(renderedQueries[2].sql).toContain("source_inbox_id IN (");
    expect(renderedQueries.flatMap((query) => query.params)).toEqual(
      expect.arrayContaining([269119, 79370, 79377, 79378, 79379]),
    );
    for (const query of renderedQueries) {
      expect(query.sql).not.toContain("payload->>");
      expect(query.sql).not.toContain("payload #>>");
    }
  });

  it("does not execute flow-history queries while loading core order details", async () => {
    const selectResults = [
      [{
        id: 269119,
        channelId: 67,
        externalOrderId: "24-14885-40737",
        externalOrderNumber: "24-14885-40737",
      }],
      [{ id: 10, authoritySourceInboxId: null, authorizedByEventId: null }],
      [],
      [{ name: "Ebay" }],
    ];
    const database = {
      select: vi.fn(() => resolvedSelect(selectResults.shift() ?? [])),
      execute: vi.fn(),
    };

    const order = await createOmsService(database).getOrderById(269119);

    expect(order?.id).toBe(269119);
    expect(order?.lines).toHaveLength(1);
    expect(database.execute).not.toHaveBeenCalled();
  });
});
