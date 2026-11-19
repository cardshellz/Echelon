import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  channelStockUpdateDeadLetterDestinationCountSql,
  channelStockUpdateDeadLetterDestinationSampleSql,
} from "../../channel-stock-update-dead-letters";
import { STOCK_LINK_ACTOR } from "../../domain/stock-link";

// Channels PR2 (PLAN-CH2 v4.1 §8 N9, SAF-12): a dead letter whose size the stock-link engine has since retired (head
// without an active link, a version retired by the engine naming the refused item) is a wait, not an open refusal.
// The real SQL is proven in stock-link.integration.test.ts (PG 27); this pins that the reader's literal actor is the
// engine's and that the exclusion adds no parameter (OMS's ops-health test matches the rendered SQL and parameters).
describe("CHANNEL_STOCK_UPDATE_DEAD_LETTER leaves out items the stock-link engine retired (N9)", () => {
  const dialect = new PgDialect();

  it.each([
    ["count", () => channelStockUpdateDeadLetterDestinationCountSql(), []],
    ["sample", () => channelStockUpdateDeadLetterDestinationSampleSql(10), [10]],
  ] as const)("excludes engine-retired items in the %s query without new parameters", (_label, build, params) => {
    const { sql, params: rendered } = dialect.sqlToQuery(build());
    expect(rendered).toEqual(params);
    expect(sql).toContain("h.active_mapping_id IS NULL");
    expect(sql).toContain("retired.lifecycle_status = 'retired'");
    expect(sql).toContain(`retired.retired_by = '${STOCK_LINK_ACTOR}'`);
    expect(sql).toContain("btrim(retired.external_inventory_item_id) = btrim(o.external_inventory_item_id_snapshot)");
  });
});
