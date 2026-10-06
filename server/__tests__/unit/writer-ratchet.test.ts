import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { scanWriterTopology } from "../../../scripts/writer-ratchet/scan";

/**
 * P2.1 — THE WRITER-RATCHET.
 *
 * The audit (ARCHITECTURE-AUDIT-2026-07.md) found 41 multi-writer tables and
 * 83 route-layer write sites — the root enabler of every double-writer bug
 * in the incident history. This test freezes the current writer topology as
 * the WORST it will ever be:
 *
 *  - A NEW (table ← writer) pair fails CI. Route the write through the
 *    owning module's API (see the ownership map in the audit §4.1). If a new
 *    writer is genuinely intended, regenerate the baseline in the same PR —
 *    the baseline diff is the review artifact.
 *  - A REMOVED pair also fails until the baseline is shrunk — so the
 *    baseline never rots and eliminated writers can't silently return.
 *
 *  Regenerate: npx tsx scripts/writer-ratchet/generate-baseline.ts
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

describe("writer-ratchet (P2.1)", () => {
  const baseline: Record<string, string[]> = JSON.parse(
    readFileSync(join(repoRoot, "scripts/writer-ratchet/baseline.json"), "utf8"),
  );
  const { writers: current } = scanWriterTopology(repoRoot);
  const { writers: currentIncludingScripts } = scanWriterTopology(repoRoot, {
    roots: ["server", "scripts"],
  });

  it.each([
    ["wms.picking_commands", "modules/wms"],
    ["inventory.replen_followups", "modules/inventory"],
    ["inventory.replen_transfer_credits", "modules/inventory"],
    ["inventory.replen_trigger_receipts", "modules/inventory"],
    ["inventory.transfer_followups", "modules/inventory"],
  ])("%s has only its warehouse operation owner, including scripts", (table, owner) => {
    expect(current[table]).toEqual([owner]);
    expect(currentIncludingScripts[table]).toEqual([owner]);
    expect(baseline[table]).toEqual([owner]);
  });

  it("wms.order_items has exactly one owning writer across runtime and operational scripts", () => {
    expect(current["wms.order_items"]).toEqual(["modules/wms"]);
    expect(currentIncludingScripts["wms.order_items"]).toEqual(["modules/wms"]);
    expect(baseline["wms.order_items"]).toEqual(["modules/wms"]);
  });

  it("the Archon order outbox has only the OMS owning writer, including operational scripts", () => {
    expect(current["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
    expect(currentIncludingScripts["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
    expect(baseline["oms.archon_order_outbox"]).toEqual(["modules/oms"]);
  });

  it("keeps country-repair approval and audit writes in the Orders maintenance owner", () => {
    for (const table of ["oms.order_country_repair_operations", "oms.order_country_repairs"]) {
      expect(current[table]).toEqual(["modules/orders"]);
      expect(currentIncludingScripts[table]).toEqual(["modules/orders"]);
      expect(baseline[table]).toEqual(["modules/orders"]);
    }
  });

  it("channel product identities have only the Channels owning writer, including operational scripts", () => {
    expect(current["channels.channel_product_identities"]).toEqual(["modules/channels"]);
    expect(currentIncludingScripts["channels.channel_product_identities"]).toEqual(["modules/channels"]);
    expect(baseline["channels.channel_product_identities"]).toEqual(["modules/channels"]);
  });

  it.each([
    ["oms.order_edit_events", "modules/order-edits"],
    ["oms.order_edit_operations", "modules/order-edits"],
    ["oms.order_edit_settings", "modules/order-edits"],
    ["oms.order_edit_paid_projections", "modules/oms"],
    ["oms.order_edit_provider_holds", "modules/oms"],
  ])("%s has only its declared order-edit owner, including scripts", (table, owner) => {
    expect(current[table]).toEqual([owner]);
    expect(currentIncludingScripts[table]).toEqual([owner]);
    expect(baseline[table]).toEqual([owner]);
  });

  it("order edits cannot become another WMS order or OMS retry queue writer", () => {
    expect(currentIncludingScripts["wms.orders"]).not.toContain("modules/order-edits");
    expect(currentIncludingScripts["oms.webhook_retry_queue"]).toEqual(["modules/oms"]);
  });

  it("no table gains a writer that is not in the baseline", () => {
    const added: string[] = [];
    for (const [table, buckets] of Object.entries(current)) {
      const allowed = new Set(baseline[table] ?? []);
      for (const b of buckets) {
        if (!allowed.has(b)) added.push(`${table}  ←  ${b}`);
      }
    }
    expect(
      added,
      `NEW writer(s) detected outside the baseline. Writes belong in the table's ` +
        `owning module (ownership map: ARCHITECTURE-AUDIT-2026-07.md §4.1) — call its ` +
        `public API instead. If this new writer is genuinely intended and reviewed, ` +
        `regenerate the baseline in this PR:\n  npx tsx scripts/writer-ratchet/generate-baseline.ts\n\n` +
        added.join("\n"),
    ).toEqual([]);
  });

  it("keeps private return intake and label writes in their Returns owner", () => {
    const tables = [
      "returns.customer_login_challenges",
      "returns.return_policy_shipping",
      "returns.customer_return_label_controls",
      "returns.customer_return_label_control_events",
      "returns.customer_return_allocation_case_items",
      "returns.customer_return_case_links",
      "returns.customer_return_intakes",
      "returns.customer_return_label_attempts",
      "returns.customer_return_label_events",
      "returns.customer_return_parcel_items",
      "returns.customer_return_parcels",
      "returns.customer_return_quote_decisions",
      "returns.customer_return_submission_commands",
    ];
    for (const table of tables) {
      expect(current[table]).toEqual(["modules/returns"]);
      expect(currentIncludingScripts[table]).toEqual(["modules/returns"]);
      expect(baseline[table]).toEqual(["modules/returns"]);
    }
    for (const legacy of ["returns.customer_return_settings", "returns.customer_return_settings_events"]) {
      expect(current[legacy]).toBeUndefined();
      expect(currentIncludingScripts[legacy]).toBeUndefined();
      expect(baseline[legacy]).toBeUndefined();
    }
  });

  it("keeps Walmart connection writes in channels and order reconciliation writes in OMS", () => {
    for (const table of ["channels.walmart_connections", "channels.walmart_connection_events", "channels.walmart_order_receipts"]) {
      expect(current[table]).toEqual(["modules/channels"]);
    }
    for (const table of ["oms.oms_orders", "oms.oms_order_lines", "oms.oms_order_events"]) {
      expect(current[table]).toContain("modules/oms");
      expect(current[table]).not.toContain("modules/channels");
    }
  });

  it("keeps selective listing publication and inventory membership with their owning modules", () => {
    const publicationOwners: Record<string, string[]> = {
      "modules/marketplace-listings": [
        "marketplace.channel_listing_drafts",
        "marketplace.channel_listing_item_claims",
        "marketplace.channel_listing_operations",
        "marketplace.channel_listing_publication_events",
        "marketplace.channel_listing_reviews",
      ],
      "modules/inventory-planning": [
        "inventory.publication_initial_scope_receipts",
        "inventory.publication_listing_setup_identities",
        "inventory.publication_listing_setup_scopes",
        "inventory.publication_membership_applications",
        "inventory.publication_membership_heads",
        "inventory.publication_membership_versions",
      ],
    };
    for (const topology of [current, currentIncludingScripts, baseline]) {
      for (const [owner, tables] of Object.entries(publicationOwners)) {
        for (const table of tables) expect(topology[table]).toEqual([owner]);
      }
      // The existing eBay pricing route is retained for compatibility. New
      // publication routes delegate pricing writes to the Channels owner.
      expect(topology["channels.channel_pricing_rules"]).toEqual([
        "modules/channels",
        "server/routes/ebay/ebay-pricing.routes.ts",
      ]);
    }
  });

  it("eliminated writers are removed from the baseline (no rot)", () => {
    const stale: string[] = [];
    for (const [table, buckets] of Object.entries(baseline)) {
      const now = new Set(current[table] ?? []);
      for (const b of buckets) {
        if (!now.has(b)) stale.push(`${table}  ←  ${b}`);
      }
    }
    expect(
      stale,
      `Writer(s) eliminated — nice. Shrink the baseline in this PR so the ` +
        `improvement is locked in:\n  npx tsx scripts/writer-ratchet/generate-baseline.ts\n\n` +
        stale.join("\n"),
    ).toEqual([]);
  });

  it("keeps the catalog cleanup's purchase and count mutations with their existing owners", () => {
    for (const topology of [current,currentIncludingScripts]) {
      for (const table of ["procurement.po_events","procurement.purchase_order_lines","procurement.vendor_products"]) {
        expect(topology[table]).toEqual(["modules/procurement"]);
      }
      expect(topology["inventory.cycle_count_items"]).not.toContain("modules/catalog");
      expect(topology["public.audit_events"]).not.toContain("modules/catalog");
      expect(topology["catalog.product_cleanup_receipts"]).toEqual(["modules/catalog"]);
    }
    expect(current["inventory.cycle_count_items"]).toEqual(["modules/inventory"]);
    // Existing QA fixture writer is unchanged; the production cleanup does not
    // add a second runtime owner or a new script writer.
    expect(currentIncludingScripts["inventory.cycle_count_items"]).toEqual(["modules/inventory","scripts/create-daily-replen-qa-counts.ts"]);
  });
});
