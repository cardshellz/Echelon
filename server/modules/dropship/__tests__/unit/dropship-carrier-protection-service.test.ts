import { describe, expect, it } from "vitest";
import {
  calculateCarrierProtectionCredit,
  DropshipCarrierProtectionService,
  type CarrierProtectionAssignmentRecord,
  type CarrierProtectionMutationResult,
  type CarrierProtectionOverview,
  type CarrierProtectionPolicyRecord,
  type CarrierProtectionRepository,
} from "../../application/dropship-carrier-protection-service";

const now = new Date("2026-07-10T12:00:00.000Z");

describe("DropshipCarrierProtectionService", () => {
  it("normalizes and creates an immutable policy version command", async () => {
    const repository = new FakeRepository();
    const service = makeService(repository);

    await service.createPolicy({
      policyKey: " standard carrier protection ",
      name: "Standard Carrier Protection",
      status: "active",
      coveredLoss: true,
      coveredMisdelivery: true,
      coveredDamage: true,
      merchandiseReimbursementBps: 10000,
      shippingReimbursementBps: 10000,
      deductibleCents: 0,
      maxCreditCents: null,
      lossWaitDays: 7,
      misdeliveryWaitDays: 2,
      damageInspectionRequired: true,
      payoutTrigger: "internal_approval",
      carrierClaimRequired: true,
      approvalMode: "manual",
      automaticApprovalLimitCents: null,
      idempotencyKey: "carrier-policy-001",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(repository.policyInput).toMatchObject({
      policyKey: "STANDARD_CARRIER_PROTECTION",
      effectiveFrom: now,
      effectiveTo: null,
      idempotencyKey: "carrier-policy-001",
      requestHash: expect.any(String),
    });
  });

  it("rejects policies without coverage and automatic approval without a limit", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.createPolicy({
      policyKey: "NONE",
      name: "Invalid",
      coveredLoss: false,
      coveredMisdelivery: false,
      coveredDamage: false,
      approvalMode: "automatic",
      idempotencyKey: "carrier-policy-002",
      actor: { actorType: "admin" },
    })).rejects.toThrow();
  });

  it("calculates reimbursement from wholesale and shipping only with deductible and cap", () => {
    expect(calculateCarrierProtectionCredit({
      wholesaleCostCents: 4000,
      shippingChargeCents: 800,
      policy: { merchandiseReimbursementBps: 10000, shippingReimbursementBps: 10000, deductibleCents: 100, maxCreditCents: 4500 },
    })).toBe(4500);
  });

  it("applies the cap before converting a large exact calculation back to number", () => {
    expect(calculateCarrierProtectionCredit({
      wholesaleCostCents: Number.MAX_SAFE_INTEGER,
      shippingChargeCents: Number.MAX_SAFE_INTEGER,
      policy: {
        merchandiseReimbursementBps: 10000,
        shippingReimbursementBps: 10000,
        deductibleCents: 0,
        maxCreditCents: Number.MAX_SAFE_INTEGER,
      },
    })).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects an uncapped calculated credit outside the safe integer range", () => {
    expect(() => calculateCarrierProtectionCredit({
      wholesaleCostCents: Number.MAX_SAFE_INTEGER,
      shippingChargeCents: Number.MAX_SAFE_INTEGER,
      policy: {
        merchandiseReimbursementBps: 10000,
        shippingReimbursementBps: 10000,
        deductibleCents: 0,
        maxCreditCents: null,
      },
    })).toThrowError(expect.objectContaining({ code: "DROPSHIP_CARRIER_PROTECTION_INVALID_MONEY" }));
  });

  it("rejects scoped conditions on the default assignment", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.createAssignment({
      policyId: 1,
      name: "Invalid default",
      priority: 0,
      isDefault: true,
      channelId: 103,
      idempotencyKey: "carrier-assignment-001",
      actor: { actorType: "admin" },
    })).rejects.toThrow();
  });

  it("rejects incomplete hierarchical assignment selectors", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.createAssignment({
      policyId: 1,
      name: "Ambiguous service",
      priority: 10,
      isDefault: false,
      service: "Ground",
      destinationRegion: "PA",
      idempotencyKey: "carrier-assignment-002",
      actor: { actorType: "admin" },
    })).rejects.toThrow();
  });

  it("fails closed when no active assignment matches a carrier event", async () => {
    const service = makeService(new FakeRepository());
    await expect(service.resolvePolicy({
      eventType: "loss",
      channelId: 103,
      warehouseId: 1,
      carrier: "usps",
      service: "Ground Advantage",
      destinationCountry: "us",
      destinationRegion: "pa",
      shipmentValueCents: 4800,
    })).rejects.toMatchObject({ code: "DROPSHIP_CARRIER_PROTECTION_POLICY_NOT_FOUND" });
  });
});

function makeService(repository: CarrierProtectionRepository): DropshipCarrierProtectionService {
  return new DropshipCarrierProtectionService({
    repository,
    clock: { now: () => now },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
}

class FakeRepository implements CarrierProtectionRepository {
  policyInput: Parameters<CarrierProtectionRepository["createPolicy"]>[0] | null = null;

  async getOverview(generatedAt: Date): Promise<CarrierProtectionOverview> {
    return { policies: [], assignments: [], generatedAt };
  }

  async createPolicy(input: Parameters<CarrierProtectionRepository["createPolicy"]>[0]): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    this.policyInput = input;
    return { record: policyRecord(input), idempotentReplay: false };
  }

  async retirePolicy(): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    throw new Error("Not used");
  }

  async activatePolicy(): Promise<CarrierProtectionMutationResult<CarrierProtectionPolicyRecord>> {
    throw new Error("Not used");
  }

  async createAssignment(): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    throw new Error("Not used");
  }

  async deactivateAssignment(): Promise<CarrierProtectionMutationResult<CarrierProtectionAssignmentRecord>> {
    throw new Error("Not used");
  }

  async resolvePolicy(): Promise<null> {
    return null;
  }
}

function policyRecord(input: Parameters<CarrierProtectionRepository["createPolicy"]>[0]): CarrierProtectionPolicyRecord {
  return {
    policyId: 1, policyKey: input.policyKey, version: 1, supersedesPolicyId: input.supersedesPolicyId ?? null, name: input.name, status: input.status,
    coveredLoss: input.coveredLoss, coveredMisdelivery: input.coveredMisdelivery, coveredDamage: input.coveredDamage,
    merchandiseReimbursementBps: input.merchandiseReimbursementBps, shippingReimbursementBps: input.shippingReimbursementBps,
    deductibleCents: input.deductibleCents, maxCreditCents: input.maxCreditCents, lossWaitDays: input.lossWaitDays,
    misdeliveryWaitDays: input.misdeliveryWaitDays, damageInspectionRequired: input.damageInspectionRequired,
    payoutTrigger: input.payoutTrigger, carrierClaimRequired: input.carrierClaimRequired, approvalMode: input.approvalMode,
    automaticApprovalLimitCents: input.automaticApprovalLimitCents, effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo, createdBy: input.actor.actorId ?? null, createdAt: input.now, retiredAt: null,
  };
}
