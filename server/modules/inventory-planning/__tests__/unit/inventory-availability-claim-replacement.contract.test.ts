import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalAvailabilityClaimReplacementCommandSchema,
  canonicalAvailabilityClaimReplacementResultSchema,
} from "@shared/types/inventory-availability-claims";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0649_inventory_availability_claim_replacement.sql"),
  "utf8",
);
const repository = readFileSync(
  resolve(
    process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
  ),
  "utf8",
);

describe("canonical availability claim replacement contract", () => {
  it("requires optimistic predecessor identity and audited idempotency", () => {
    expect(canonicalAvailabilityClaimReplacementCommandSchema.parse({
      orderId: 70,
      expectedClaimId: "9",
      idempotencyKey: "replace-claim:70:2",
      actor: "operator-1",
      reason: "Accepted order demand changed",
    })).toEqual(expect.objectContaining({ expectedClaimId: "9" }));
    expect(canonicalAvailabilityClaimReplacementCommandSchema.safeParse({
      orderId: 70,
      expectedClaimId: "0",
      idempotencyKey: "replace-claim:70:2",
      actor: "operator-1",
      reason: "Accepted order demand changed",
    }).success).toBe(false);
  });

  it("returns both immutable predecessor identity and the complete successor plan", () => {
    const result = canonicalAvailabilityClaimReplacementResultSchema.parse({
      outcome: "replaced",
      orderId: 70,
      supersededClaimId: "9",
      supersededClaimKey: "order:70:availability:revision:1",
      supersededRevision: 1,
      replacementClaim: {
        claimId: "10",
        claimKey: "order:70:availability:revision:2",
        revision: 2,
        runtimeAuthorityRevision: "3",
        plan: {
          requestKey: "order:70:availability:revision:2",
          scope: { kind: "warehouse", warehouseId: 1 },
          status: "satisfied",
          lines: [{
            lineKey: "order-item:71",
            targetVariantId: 101,
            requestedQty: "2",
            plannedQty: "2",
            shortfallQty: "0",
          }],
          resourceClaims: [],
          operations: [],
          fulfillmentGroups: [],
          modelEvidence: [],
          blockers: [],
          snapshotFingerprint: "a".repeat(64),
        },
      },
      releasedResourceQty: "3",
      releasedLotQty: "3",
      idempotentReplay: false,
    });
    expect(result.replacementClaim.revision).toBe(2);
    expect(result.supersededRevision).toBe(1);
  });

  it("installs same-order, one-successor lineage without activating authority or mutating stock", () => {
    expect(migration).toContain("ADD COLUMN supersedes_claim_id BIGINT");
    expect(migration).toContain("availability_claims_supersedes_same_order_fk");
    expect(migration).toContain("availability_claims_supersedes_claim_uq");
    expect(migration).toContain("'replace'");
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.inventory_lots/i);
    expect(migration).not.toMatch(/UPDATE\s+wms\./i);
  });

  it("keeps release, replan, successor reservation, receipt, and events in one serializable transaction", () => {
    const start = repository.indexOf("async replaceOrderClaim(");
    const replacement = repository.slice(start, repository.indexOf("async pickClaimLine(", start));
    expect(replacement).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(replacement).toContain("expectedClaimId");
    expect(replacement).toContain("cancelOpenBuildHandoffs");
    expect(replacement).toContain("releaseClaimResources");
    expect(replacement).toContain("captureActiveClaimSupplySnapshotInsideTransaction");
    expect(replacement).toContain("planCanonicalClaim");
    expect(replacement).toContain("reserveClaimResources");
    expect(replacement).toContain("persistReplacementCommandAndEvents");
    expect(replacement).toContain('await client.query("COMMIT")');
    expect(replacement.indexOf("releaseClaimResources"))
      .toBeLessThan(replacement.indexOf("planCanonicalClaim"));
    expect(replacement.indexOf("planCanonicalClaim"))
      .toBeLessThan(replacement.indexOf("reserveClaimResources"));
  });
});
