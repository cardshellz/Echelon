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
    // hourly OMS<->WMS cascade, Reconcile V2 outbound sync, Reconcile V1 sweep
    expect(branches.length).toBe(3);
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

  it("the V2 inline OMS shipped-flip never touches money-final orders", () => {
    const flip = INDEX_SRC.slice(
      INDEX_SRC.indexOf("const nextFulfillmentStatus"),
      INDEX_SRC.indexOf("WITH shipped_by_line"),
    );
    expect(flip).toContain("AND status NOT IN ('cancelled', 'refunded')");
  });

  it("SHIPMENT_SHIPPED_OMS_OPEN excludes money-final OMS orders in detection AND remediation", () => {
    const guards =
      FLOW_SRC.match(
        /oo\.status NOT IN \('shipped', 'partially_shipped', 'cancelled', 'refunded'\)/g,
      ) ?? [];
    // detection count + detection sample + remediation UPDATE
    expect(guards.length).toBe(3);
  });

  it("shipped-but-terminal becomes a requires_review flag, not a silent skip", () => {
    expect(FLOW_SRC).toContain("shipped_but_oms_terminal");
    expect(FLOW_SRC).toContain("shipment_shipped_oms_terminal_review");
  });
});
