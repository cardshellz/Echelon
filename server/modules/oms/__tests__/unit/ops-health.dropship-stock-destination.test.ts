import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  DROPSHIP_EBAY_PUBLISHED_OFFER_WAIT_DEAD_LETTER_CLASS,
  DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED_MESSAGE,
  dropshipEbayStockOfferUnverifiedCountSql,
  dropshipEbayStockOfferUnverifiedSampleSql,
  DROPSHIP_STOCK_DESTINATION_HELD_MESSAGE,
  DROPSHIP_STOCK_DESTINATION_MISSING_MESSAGE,
  dropshipStockDestinationHeldCountSql,
  dropshipStockDestinationHeldSampleSql,
  dropshipStockDestinationMissingCountSql,
  dropshipStockDestinationMissingSampleSql,
} from "../../dropship-stock-destination-health";
import { dropshipStockDestinationSourceReadySql } from "../../../inventory-planning/infrastructure/dropship-stock-destination-source-ready.sql";
import { getOmsOpsHealth } from "../../ops-health.service";
import { DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT } from "../../../dropship/infrastructure/dropship-ebay-inventory-publication.adapter";
import { evaluateOmsOpsAlert } from "../../oms-ops-alert.service";

// Fix PR 2a-2 (plan F2 2.7, Q1 default): the critical issue that reaches the ops
// alert webhook when a managed Dropship eBay store has no single live destination.
describe("ops-health :: DROPSHIP_STOCK_DESTINATION_MISSING", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));
  const window = sql`NOW() - INTERVAL '14 days'`;
  const countQuery = render(dropshipStockDestinationMissingCountSql(window));
  const sampleQuery = render(dropshipStockDestinationMissingSampleSql(window, 10));
  const heldCountQuery = render(dropshipStockDestinationHeldCountSql(window));
  const heldSampleQuery = render(dropshipStockDestinationHeldSampleSql(window, 10));
  const sampleRow = { store_connection_id: 22, vendor_id: 10, listing_count: 3, recent_push: true, waiting_resend: false,
    live_destination_count: 1, destination_status: "source_not_ready" };
  const heldRow = { ...sampleRow, destination_status: "held" };

  async function healthWith(count: number, held = 0) {
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    const execute = vi.fn(async (query: any) => {
      const rendered = render(query);
      if (rendered === countQuery) return { rows: [{ count }] };
      if (rendered === sampleQuery) return { rows: count > 0 ? [sampleRow] : [] };
      if (rendered === heldCountQuery) return { rows: [{ count: held }] };
      if (rendered === heldSampleQuery) return { rows: held > 0 ? [heldRow] : [] };
      return { rows: [{ count: 0 }] };
    });
    try {
      return { health: await getOmsOpsHealth({ execute }), execute };
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous;
    }
  }

  it("is critical, with the store sample and the plain message, and it reaches the alert", async () => {
    const { health, execute } = await healthWith(1);
    const rendered = execute.mock.calls.map(([query]) => render(query));
    expect(rendered).toContain(countQuery);
    expect(rendered).toContain(sampleQuery);
    const issue = health.issues.find((entry) => entry.code === "DROPSHIP_STOCK_DESTINATION_MISSING");
    expect(issue).toEqual({ code: "DROPSHIP_STOCK_DESTINATION_MISSING", severity: "critical", count: 1,
      message: DROPSHIP_STOCK_DESTINATION_MISSING_MESSAGE, sample: [sampleRow] });
    expect(DROPSHIP_STOCK_DESTINATION_MISSING_MESSAGE).toBe(
      "A connected Dropship eBay store has listings but no single live Card Shellz stock destination that is ready to publish, so its eBay quantities are not updating. Set up, turn on or finish (sealed supply warehouse) its stock destination in Channel Inventory.");
    expect(health.status).toBe("critical");
    expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).toContain("DROPSHIP_STOCK_DESTINATION_MISSING");
  });

  it("raises nothing when every managed store has its one live destination", async () => {
    const { health } = await healthWith(0);
    expect(health.issues.some((entry) => entry.code === "DROPSHIP_STOCK_DESTINATION_MISSING")).toBe(false);
    expect(health.issues.some((entry) => entry.code === "DROPSHIP_STOCK_DESTINATION_HELD")).toBe(false);
  });

  // Review CF-3: a held destination is an operator's own pause: shown as a warning, never paged.
  it("shows a store whose one live destination is on hold as a warning that does not reach the alert", async () => {
    const { health } = await healthWith(0, 1);
    expect(health.issues.find((entry) => entry.code === "DROPSHIP_STOCK_DESTINATION_HELD")).toEqual({ code: "DROPSHIP_STOCK_DESTINATION_HELD",
      severity: "warning", count: 1, message: DROPSHIP_STOCK_DESTINATION_HELD_MESSAGE, sample: [heldRow] });
    expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).not.toContain("DROPSHIP_STOCK_DESTINATION_HELD");
  });

  it("counts only managed live, verified eBay stores with demand, under canonical authority, by the stock link's destination status", () => {
    const { sql: text, params } = dialect.sqlToQuery(dropshipStockDestinationMissingCountSql(window));
    expect(text).toContain("authority = 'canonical'");
    expect(text).toContain("sc.platform = 'ebay' AND sc.status = 'connected'");
    expect(text).toContain("sc.external_account_identity_scheme = 'provider_user_id'");
    expect(text).toContain("lc.is_active = true AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync'");
    expect(text).toContain("st.state = 'live' AND st.publication_authority = 'echelon'");
    expect(text).toContain("t.external_scope_id = s.account_id");
    // Review MC-1: the source readiness the link writer checks (readTargets for a Dropship destination).
    expect(text).toContain("b.lifecycle_status = 'sealed'");
    expect(text).toContain("n.id IS NULL OR n.lifecycle_status <> 'active'");
    expect(text).toContain("c.status = 'active'");
    // Supplied by inventory-planning, the only reader of the supply definitions (foundation migration contract).
    expect(text).toContain(`${dialect.sqlToQuery(dropshipStockDestinationSourceReadySql()).sql} AS source_ready`);
    expect(text).toContain("WHEN live_destination_count = 1 AND NOT live_destination_source_ready THEN 'source_not_ready'");
    expect(text).toContain("WHERE listing_count > 0 OR recent_push OR waiting_resend");
    expect(text).toContain("NOW() - INTERVAL '14 days'");
    expect(params).toEqual(["missing", "not_live", "duplicated", "source_not_ready"]);
    expect(dialect.sqlToQuery(dropshipStockDestinationHeldCountSql(window)).params).toEqual(["held"]);
  });
});

// Review CF-5: a published Dropship eBay offer whose stock updates the outbox refuses for good is frozen at its last
// quantity; it reaches the alert.
describe("ops-health :: DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED", () => {
  const dialect = new PgDialect();
  const render = (query: any) => JSON.stringify(dialect.sqlToQuery(query));
  const countQuery = render(dropshipEbayStockOfferUnverifiedCountSql());
  const sampleQuery = render(dropshipEbayStockOfferUnverifiedSampleSql(10));
  const row = { publication_target_id: 7, store_connection_id: 22, product_variant_id: 101, sku: "P5",
    last_error_class: "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN", desired_quantity: "17", updated_at: "2026-10-21T12:00:00.000Z" };

  it("is critical, with the offer sample, and reaches the alert", async () => {
    const previous = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = "true";
    try {
      const health = await getOmsOpsHealth({ execute: vi.fn(async (query: any) => {
        const rendered = render(query);
        if (rendered === countQuery) return { rows: [{ count: 1 }] };
        if (rendered === sampleQuery) return { rows: [row] };
        return { rows: [{ count: 0 }] };
      }) });
      expect(health.issues.find((entry) => entry.code === "DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED")).toEqual({
        code: "DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED", severity: "critical", count: 1, message: DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED_MESSAGE, sample: [row] });
      expect(evaluateOmsOpsAlert(health, Date.now()).criticalIssues.map((entry) => entry.code)).toContain("DROPSHIP_EBAY_STOCK_OFFER_UNVERIFIED");
    } finally {
      if (previous === undefined) delete process.env.DISABLE_SCHEDULERS;
      else process.env.DISABLE_SCHEDULERS = previous;
    }
  });

  it("counts only the newest revision of a Dropship eBay destination's variant, dead-lettered on offer identity", () => {
    const { sql: text, params } = dialect.sqlToQuery(dropshipEbayStockOfferUnverifiedCountSql());
    expect(text).toContain("DISTINCT ON (o.publication_target_id, o.product_variant_id)");
    expect(text).toContain("ORDER BY o.publication_target_id, o.product_variant_id, o.desired_revision DESC");
    expect(text).toContain("t.destination_kind = 'dropship_store_connection' AND sc.platform = 'ebay'");
    expect(text).toContain("newest.state = 'dead_letter'");
    expect(params).toEqual(["DROPSHIP_EBAY_OFFER_IDENTITY_CHANGED", "DROPSHIP_EBAY_OFFER_IDENTITY_UNPROVEN",
      "DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT"]);
  });

  // Review AV1-1: the outbox gave up waiting for a push while a PUBLISHED offer it had not recorded was on sale.
  it("also counts a published-offer wait the outbox gave up on, once no push of that store variant is running", () => {
    const { sql: text } = dialect.sqlToQuery(dropshipEbayStockOfferUnverifiedCountSql());
    expect(text).toMatch(/OR \(newest\.last_error_class = \$3 AND NOT EXISTS \(SELECT 1 FROM dropship\.dropship_listing_push_job_items ji/);
    expect(text).toContain("j.store_connection_id = t.dropship_store_connection_id AND ji.product_variant_id = newest.product_variant_id");
    expect(text).toContain("j.status IN ('queued', 'processing') AND ji.status IN ('queued', 'processing')");
    // The OMS module names the adapter's class as a literal (no cross-module import); this pins the two together.
    expect(DROPSHIP_EBAY_PUBLISHED_OFFER_WAIT_DEAD_LETTER_CLASS).toBe(DROPSHIP_EBAY_PUBLISHED_OFFER_PUSH_IN_FLIGHT);
  });
});
