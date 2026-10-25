import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  channelStockUpdateDeadLetterDestinationCountSql,
  channelStockUpdateDeadLetterDestinationSampleSql,
} from "../../../inventory-planning/channel-stock-update-dead-letters";
import {
  CHANNEL_STOCK_UPDATE_DEAD_LETTER_CODE,
  CHANNEL_STOCK_UPDATE_DEAD_LETTER_MESSAGE,
  getOmsOpsHealth,
} from "../../ops-health.service";
import { evaluateOmsOpsAlert } from "../../oms-ops-alert.service";

// Channels PR1 (PLAN-CH-v3 section 6, Ops Health): a channel store's stock updates the
// outbox refused for good (for example Shopify 404/422) are critical and reach the alert.
// The real SQL is proven against PostgreSQL in
// inventory-planning/__tests__/integration/channel-stock-update-dead-letter.integration.test.ts.
describe("ops-health :: CHANNEL_STOCK_UPDATE_DEAD_LETTER", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));
  const countQuery = render(channelStockUpdateDeadLetterDestinationCountSql());
  const sampleQuery = render(channelStockUpdateDeadLetterDestinationSampleSql(10));
  const row = { publication_target_id: 4, channel_id: 35, channel_name: "Card Shellz Shopify", provider_key: "shopify",
    channel_connection_id: 7, external_scope_id: "98765", refused_sizes: 3,
    error_codes: ["SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "SHOPIFY_INVENTORY_REJECTED"], product_variant_ids: [101, 102, 103],
    outbox_ids: ["91", "90", "88"], last_refused_at: "2026-10-22T12:00:00.000Z" };

  async function healthWith(count: number) {
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const rendered = render(query);
      if (rendered === countQuery) return { rows: [{ count }] };
      if (rendered === sampleQuery) return { rows: count > 0 ? [row] : [] };
      return { rows: [{ count: 0 }] };
    });
    try {
      return { health: await getOmsOpsHealth({ execute }), execute };
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous;
    }
  }

  it("is critical, counted per store, with each store's correlation ids, and reaches the alert", async () => {
    const { health, execute } = await healthWith(1);
    const rendered = execute.mock.calls.map(([query]) => render(query));
    expect(rendered).toContain(countQuery);
    expect(rendered).toContain(sampleQuery);
    expect(health.issues.find((entry) => entry.code === "CHANNEL_STOCK_UPDATE_DEAD_LETTER")).toEqual({
      code: "CHANNEL_STOCK_UPDATE_DEAD_LETTER", severity: "critical", count: 1,
      message: "Some stock updates to a store were refused and stopped. Review them.", sample: [row] });
    expect(CHANNEL_STOCK_UPDATE_DEAD_LETTER_CODE).toBe("CHANNEL_STOCK_UPDATE_DEAD_LETTER");
    expect(CHANNEL_STOCK_UPDATE_DEAD_LETTER_MESSAGE).toBe("Some stock updates to a store were refused and stopped. Review them.");
    expect(health.status).toBe("critical");
    expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).toContain("CHANNEL_STOCK_UPDATE_DEAD_LETTER");
  });

  it("raises nothing when no store has a refused stock update", async () => {
    const { health } = await healthWith(0);
    expect(health.issues.some((entry) => entry.code === "CHANNEL_STOCK_UPDATE_DEAD_LETTER")).toBe(false);
  });

  // The aggregation (stores, sizes, codes, outbox ids), the live-store scope and the Dropship
  // exclusion are proven against PostgreSQL in channel-stock-update-dead-letter.integration.test.ts.
  // This pins the predicate that decides when the issue clears, the bound sample size, and the
  // canonical-authority clause, which PostgreSQL cannot exercise after activation: the database
  // refuses to return from canonical to legacy (migrations/0638_inventory_availability_cutover.sql).
  it("clears a store only once the store accepted a newer update of the refused size, under canonical authority", () => {
    const { sql: text } = dialect.sqlToQuery(channelStockUpdateDeadLetterDestinationCountSql());
    expect(text).toContain("accepted.desired_revision > o.desired_revision");
    expect(text).toContain("accepted.acknowledged_at IS NOT NULL");
    expect(text).toContain("a.singleton_key = true AND a.authority = 'canonical'");
    expect(dialect.sqlToQuery(channelStockUpdateDeadLetterDestinationSampleSql(10)).params).toEqual([10]);
  });
});
