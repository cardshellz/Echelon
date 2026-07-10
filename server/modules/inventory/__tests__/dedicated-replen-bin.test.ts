import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural guards for resolveDedicatedReplenBin — the need-agnostic single
 * replen-source lookup that powers the gun pick-screen "grab more from BULK-A-02"
 * hint per line item.
 *
 * Requirements (from the warehouse spec):
 *   - EXACT mirror: show the same bin the replen engine pulls from — reuse
 *     resolveReplenSourceForNeed, not a bespoke heuristic.
 *   - Single dedicated bin only.
 *   - Pallet-pick items are excluded (their replen is a manager job across
 *     multiple reserves, not a picker-facing bin).
 *   - Need-agnostic: no trigger/threshold gate (unlike checkReplenNeeded).
 */

const SRC = readFileSync(
  resolve(__dirname, "../application/replenishment.use-cases.ts"),
  "utf8",
);

function methodBody(name: string): string {
  const start = SRC.indexOf(`async ${name}(`);
  if (start < 0) throw new Error(`method ${name} not found`);
  // Grab a generous window — enough to cover the method body.
  return SRC.slice(start, start + 2200);
}

describe("resolveDedicatedReplenBin", () => {
  it("exists as a public method", () => {
    expect(SRC).toContain("async resolveDedicatedReplenBin(");
  });

  const body = methodBody("resolveDedicatedReplenBin");

  it("excludes pallet-pick items (manager-job replen, not a single picker bin)", () => {
    expect(body).toMatch(/replenMethod === "pallet_drop"[\s\S]{0,40}return null/);
  });

  it("resolves the EXACT engine source (reuses resolveReplenSourceForNeed)", () => {
    expect(body).toContain("this.resolveReplenSourceForNeed(");
  });

  it("returns the single source bin's code, or null when none resolves", () => {
    expect(body).toContain("if (!sourceDecision.sourceLocation) return null;");
    expect(body).toContain("locationCode: sourceDecision.sourceLocation.code");
  });

  it("is need-agnostic — does NOT gate on the replen threshold/trigger", () => {
    // The whole point vs checkReplenNeeded: no threshold evaluation here.
    expect(body).not.toContain("evaluateThresholdDecision");
    expect(body).not.toContain("thresholdMet");
  });
});
