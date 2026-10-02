import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  canonicalAvailabilityClaimDisplacementCommandSchema,
  canonicalAvailabilityClaimDisplacementResultSchema,
} from "@shared/types/inventory-availability-claims";
import { displacementEvidence, selectDisplacementDonors, type DisplacementDonor } from "../../domain/claim-displacement";
import {
  displaceClaimsForConfirmedShipment,
  type InventoryAvailabilityRuntimeClaimContext,
} from "../../application/inventory-availability-runtime-claim.service";
import { InventoryAvailabilityClaimService } from "../../application/inventory-availability-claim.service";

// C-11 on 2026-10-02: 146 slim-sleeve packs on hand, all 146 reserved by 11
// orders not yet picked (100 for one case order, #63757), while #63688 (10),
// #63695 (4), #63699 (1) and #63704 had already shipped with nothing reserved.

const donor = (orderId: number, openQty: number, claimId = orderId * 10, priority = 100): DisplacementDonor =>
  ({ claimId: BigInt(claimId), orderId, priority, openQty: BigInt(openQty) });

describe("selectDisplacementDonors", () => {
  it("takes from the newest unstarted orders first", () => {
    const selected = selectDisplacementDonors([donor(63746, 1), donor(63815, 2), donor(63808, 1), donor(63795, 5)], BigInt(4));
    expect(selected?.map((entry) => entry.orderId)).toEqual([63815, 63808, 63795]);
  });

  it("takes from the lowest pick priority first, so expedited and member orders yield last", () => {
    const selected = selectDisplacementDonors([
      donor(63815, 5, 1, 160), // newest, but a member's expedited order
      donor(63746, 5, 2, 100), // oldest standard order
      donor(63795, 5, 3, 100),
    ], BigInt(6));
    expect(selected?.map((entry) => entry.orderId)).toEqual([63795, 63746]);
  });

  it("is all or nothing: a shortfall the donors cannot cover selects nobody", () => {
    expect(selectDisplacementDonors([donor(1, 2), donor(2, 1)], BigInt(4))).toBeNull();
    expect(selectDisplacementDonors([], BigInt(1))).toBeNull();
  });

  it("needs nobody when nothing is short", () => {
    expect(selectDisplacementDonors([donor(1, 5)], BigInt(0))).toEqual([]);
  });

  it("ignores donors with nothing open and orders ties deterministically", () => {
    expect(selectDisplacementDonors([donor(5, 0), donor(4, 3, 40), donor(4, 3, 41)], BigInt(4))?.map((entry) => entry.claimId))
      .toEqual([BigInt(41), BigInt(40)]);
  });

  it("produces stable evidence for the under-lock comparison", () => {
    expect(displacementEvidence([donor(2, 1), donor(1, 3)])).toBe("20:2:100:1,10:1:100:3");
  });
});

describe("displacement command and result contracts", () => {
  const command = { orderId: 63688, expectedClaimId: "9", orderItemId: 5, quantity: "10",
    idempotencyKey: "k", actor: "picker", reason: "record shipped units" };

  it("requires a positive quantity and an exact recipient claim", () => {
    expect(canonicalAvailabilityClaimDisplacementCommandSchema.safeParse(command).success).toBe(true);
    expect(canonicalAvailabilityClaimDisplacementCommandSchema.safeParse({ ...command, quantity: "0" }).success).toBe(false);
    expect(canonicalAvailabilityClaimDisplacementCommandSchema.safeParse({ ...command, expectedClaimId: "0" }).success).toBe(false);
    expect(canonicalAvailabilityClaimDisplacementCommandSchema.safeParse({ ...command, extra: 1 }).success).toBe(false);
  });

  it("validates commands and results at the application boundary", async () => {
    const store = { displaceForConfirmedShipment: vi.fn(async () => ({ bogus: true })) };
    const service = new InventoryAvailabilityClaimService(store as any);
    await expect(service.displaceForConfirmedShipment({ ...command, quantity: "-1" }))
      .rejects.toMatchObject({ code: "INVALID_CANONICAL_CLAIM_COMMAND" });
    expect(store.displaceForConfirmedShipment).not.toHaveBeenCalled();
    await expect(service.displaceForConfirmedShipment(command)).rejects.toMatchObject({ code: "INVALID_CANONICAL_CLAIM_RESULT" });
    expect(canonicalAvailabilityClaimDisplacementResultSchema.safeParse({}).success).toBe(false);
  });
});

describe("displaceClaimsForConfirmedShipment", () => {
  const context = (displace: ReturnType<typeof vi.fn>) =>
    ({ canonical: { displaceForConfirmedShipment: displace } } as unknown as InventoryAvailabilityRuntimeClaimContext);
  const input = { orderId: 63688, claimId: "9", orderItemId: 5, quantity: 10, actor: "picker", reason: "r" };

  it("sends a schema-valid command keyed by the recipient claim and line", async () => {
    const displace = vi.fn(async () => ({ replacementClaim: { claimId: "12" }, displacedOrderIds: [63815, 63808] }));
    await expect(displaceClaimsForConfirmedShipment(context(displace), input))
      .resolves.toEqual({ outcome: "displaced", claimId: "12", displacedOrderIds: [63815, 63808] });
    const sent = (displace.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0];
    expect(canonicalAvailabilityClaimDisplacementCommandSchema.safeParse(sent).success).toBe(true);
    expect(sent).toMatchObject({ orderId: 63688, expectedClaimId: "9", orderItemId: 5, quantity: "10" });
    const again = vi.fn(async () => ({ replacementClaim: { claimId: "12" }, displacedOrderIds: [] }));
    await displaceClaimsForConfirmedShipment(context(again), input);
    expect((again.mock.calls as unknown as Array<[{ idempotencyKey: string }]>)[0][0].idempotencyKey).toBe(sent.idempotencyKey);
  });

  it("returns expected refusals as declines and rethrows anything else", async () => {
    const declined = vi.fn(async () => { throw Object.assign(new Error("none"), { code: "CLAIM_DISPLACEMENT_NO_DONORS" }); });
    await expect(displaceClaimsForConfirmedShipment(context(declined), input))
      .resolves.toMatchObject({ outcome: "declined", code: "CLAIM_DISPLACEMENT_NO_DONORS" });
    const broken = vi.fn(async () => { throw Object.assign(new Error("db"), { code: "CLAIM_DISPLACEMENT_RETRY_EXHAUSTED" }); });
    await expect(displaceClaimsForConfirmedShipment(context(broken), input)).rejects.toMatchObject({ code: "CLAIM_DISPLACEMENT_RETRY_EXHAUSTED" });
  });
});

describe("displacement repository contract", () => {
  const repository = readFileSync(resolve(process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts"), "utf8");
  const donors = repository.slice(repository.indexOf("async function loadDisplacementDonors"),
    repository.indexOf("function displacedClaimIdempotencyKey"));
  const method = repository.slice(repository.indexOf("  async displaceForConfirmedShipment("),
    repository.indexOf("  async reconcileCycleCount("));

  it("only takes from unstarted, unheld, normal-priority orders, newest first", () => {
    expect(donors).toContain("o.warehouse_status = 'ready'");
    expect(donors).toContain("COALESCE(o.on_hold, 0) = 0");
    expect(donors).toContain("COALESCE(o.priority, 0) < $4");
    expect(repository).toContain("const BUMPED_ORDER_PRIORITY = 9999;");
    expect(donors).toMatch(/l\.picked_target_qty > 0 OR l\.consumed_target_qty > 0/);
    expect(donors).toContain("r.consumer_operation_key IS NULL");
    expect(donors).toContain("ORDER BY COALESCE(o.priority, 0) ASC, c.order_id DESC, c.id DESC");
  });

  it("re-reads the donor set under lock and refuses anything short of fully reserving the confirmed line", () => {
    expect(method).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(method).toMatch(/displacementEvidence\(lockedDonors\) !== displacementEvidence\(preliminaryDonors\)/);
    expect(method).toContain('"CLAIM_DISPLACEMENT_INSUFFICIENT"');
    expect(method).toMatch(/BigInt\(confirmedLine\.shortfallQty\) !== BigInt\(0\)/);
    expect(method).toMatch(/rejectSupplyRefreshPlan\(baseline, recipientPlan\.plan\.lines\)/);
    // The recipient is planned before any donor is re-planned.
    expect(method.indexOf("const recipientPlan = await replan(recipientOrder)"))
      .toBeLessThan(method.indexOf("const donorPlan = await replan(donorOrder)"));
  });
});
