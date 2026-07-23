import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * P0.3 — engine-cancel discrimination + reconciler guards.
 *
 * The engine cancel used to answer `alreadyInState: true` for two OPPOSITE
 * outcomes — already CANCELLED (fine, no-op) and already SHIPPED (package
 * left the building) — and three reconciler sites recorded "shipped" on ANY
 * alreadyInState, resurrecting dead orders. These pins freeze the fix:
 *
 *  1. the ShipStation cancel returns a discriminated `state`
 *  2. every reconciler marks shipped ONLY on state === "already_shipped"
 *  3. terminal-transition UPDATEs after network calls carry status predicates
 *  4. SHIPMENT_SHIPPED_OMS_OPEN never auto-flips money-final OMS orders;
 *     that divergence becomes a requires_review flag instead
 */

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const INDEX_SRC = read("../../../../index.ts");
const SS_SRC = read("../../../oms/shipstation.service.ts");
const FLOW_SRC = read("../../../oms/oms-flow-reconciliation.service.ts");
const AUTHORITY_POLICY_SRC = read("../../../oms/channel-fulfillment-authority.policy.ts");
const TYPES_SRC = read("../../types.ts");

describe("P0.3 — engine-cancel discrimination", () => {
  it("the ShipStation cancel returns a discriminated state, not just a flag", () => {
    expect(SS_SRC).toContain('state: "already_cancelled"');
    expect(SS_SRC).toContain('state: "already_shipped"');
    expect(SS_SRC).toContain('state: "cancelled"');
    expect(SS_SRC).toContain('state: "not_found"');
    expect(TYPES_SRC).toContain("export type EngineCancelState");
  });

  it("reconcilers record shipped ONLY on already_shipped — never on already_cancelled", () => {
    const branches = INDEX_SRC.match(/cancelResult\?\.state === "already_shipped"/g) ?? [];
    // Hourly OMS<->WMS cancellation cascade and canonical V2 outbound sync.
    // The legacy V1 sweep is deliberately retired.
    expect(branches.length).toBe(2);
    // the old conflated branch shape must be gone
    expect(INDEX_SRC).not.toMatch(/if \(cancelResult\?\.alreadyInState\)/);
  });

  it("the hourly cascade's cancelled UPDATE carries a shipped-guard predicate", () => {
    const cascade = INDEX_SRC.slice(
      INDEX_SRC.indexOf("[OMS<->WMS Reconcile] Engine order"),
      INDEX_SRC.indexOf("[OMS<->WMS Reconcile] Cancelled engine order"),
    );
    expect(cascade).toContain("SET status = 'cancelled'");
    expect(cascade).toContain("AND status NOT IN ('shipped', 'returned', 'lost')");
  });

  it("the V2 callback delegates finality to canonical fulfillment authority", () => {
    const finalizeStart = SS_SRC.indexOf(
      "async function finalizeCanonicalShipNotifyPackage",
    );
    const finalizeEnd = SS_SRC.indexOf("\n  async function ", finalizeStart + 1);
    expect(finalizeStart).toBeGreaterThanOrEqual(0);
    expect(finalizeEnd).toBeGreaterThan(finalizeStart);
    const finalize = SS_SRC.slice(finalizeStart, finalizeEnd);
    expect(finalize).toContain("requireFulfillmentAuthority().recordPhysicalPackage");
    expect(INDEX_SRC).not.toContain("WITH shipped_by_line");
    expect(AUTHORITY_POLICY_SRC).toContain(
      'const TERMINAL_COMMERCIAL_ORDER_STATUSES = new Set(["cancelled", "refunded"])',
    );
    expect(AUTHORITY_POLICY_SRC).toContain(
      'const TERMINAL_FINANCIAL_STATUSES = new Set(["refunded", "voided"])',
    );
  });

  it("SHIPMENT_SHIPPED_OMS_OPEN excludes money-final orders and hands eligible packages to canonical authority", () => {
    const guards =
      FLOW_SRC.match(
        /oo\.status NOT IN \('shipped', 'partially_shipped', 'cancelled', 'refunded'\)/g,
      ) ?? [];
    // Detection count + sample. Remediation no longer writes OMS status directly.
    expect(guards.length).toBe(2);
    const remediation = FLOW_SRC.slice(
      FLOW_SRC.indexOf('input.code === "SHIPMENT_SHIPPED_OMS_OPEN"'),
      FLOW_SRC.indexOf('input.code === "SHOPIFY_SHIPMENT_FULFILLMENT_NOT_PUSHED"'),
    );
    expect(remediation).toContain("handoffLegacyShipmentToChannelFulfillment");
    expect(remediation).not.toMatch(/UPDATE\s+oms\.oms_orders\s+SET\s+status\s*=\s*'shipped'/);
  });

  it("shipped-but-terminal becomes a requires_review flag, not a silent skip", () => {
    expect(FLOW_SRC).toContain("shipped_but_oms_terminal");
    expect(FLOW_SRC).toContain("shipment_shipped_oms_terminal_review");
  });
});
