import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipReturnService,
  type CreateDropshipRmaInput,
  type DropshipReturnRepository,
  type DropshipRmaDetail,
  type DropshipRmaInspectionResult,
  type DropshipRmaListResult,
  type DropshipRmaStatusUpdateResult,
  type ProcessDropshipRmaInspectionInput,
  type UpdateDropshipRmaStatusInput,
} from "../../application/dropship-return-service";
import type {
  DropshipProvisionVendorRepositoryResult,
  DropshipProvisionedVendorProfile,
  DropshipVendorProvisioningService,
} from "../../application/dropship-vendor-provisioning-service";

const now = new Date("2026-05-02T19:00:00.000Z");

describe("DropshipReturnService", () => {
  it("scopes vendor return visibility through Shellz Club member provisioning", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await service.listForMember("member-1", { statuses: ["credited"], page: 2, limit: 10 });

    expect(repository.lastListInput).toMatchObject({
      vendorId: 10,
      statuses: ["credited"],
      page: 2,
      limit: 10,
    });
  });

  it("creates RMAs with idempotency, request hash, actor, and clock context", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.createRma({
      vendorId: 10,
      rmaNumber: "RMA-100",
      returnWindowDays: 30,
      items: [{ productVariantId: 20, quantity: 2, requestedCreditCents: 1500 }],
      idempotencyKey: "create-rma-100",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.rma.rmaNumber).toBe("RMA-100");
    expect(repository.lastCreateInput).toMatchObject({
      vendorId: 10,
      idempotencyKey: "create-rma-100",
      now,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(repository.lastCreateInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_RMA_CREATED" });
  });

  it("updates status with idempotency, request hash, actor, and clock context", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.updateStatus({
      rmaId: 1,
      status: "received",
      notes: "return arrived",
      idempotencyKey: "status-rma-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toMatchObject({ idempotentReplay: false, rma: { status: "received" } });
    expect(repository.lastStatusInput).toMatchObject({
      rmaId: 1,
      status: "received",
      notes: "return arrived",
      idempotencyKey: "status-rma-1",
      now,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(repository.lastStatusInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_RMA_STATUS_UPDATED" });
  });

  it("does not duplicate service logs for idempotent status update replay", async () => {
    const repository = new FakeReturnRepository();
    repository.nextStatusReplay = true;
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.updateStatus({
      rmaId: 1,
      status: "received",
      idempotencyKey: "status-rma-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.idempotentReplay).toBe(true);
    expect(logs).toHaveLength(0);
  });

  it("rejects inspection item totals that do not match wallet adjustment totals", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await expect(service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "customer",
      creditCents: 1000,
      feeCents: 100,
      items: [{ rmaItemId: 1, finalCreditCents: 900, feeCents: 100 }],
      idempotencyKey: "inspect-rma-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT" });
    expect(repository.lastInspectionInput).toBeNull();
  });

  it("finalizes inspection with wallet ledger context and logs financial amounts", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "carrier",
      creditCents: 2000,
      feeCents: 0,
      items: [{ rmaItemId: 1, finalCreditCents: 2000, feeCents: 0 }],
      idempotencyKey: "inspect-rma-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.walletLedger[0]).toMatchObject({
      type: "insurance_pool_credit",
      amountCents: 2000,
    });
    expect(repository.lastInspectionInput).toMatchObject({
      rmaId: 1,
      creditCents: 2000,
      now,
    });
    expect(repository.lastInspectionInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_RMA_INSPECTED",
      context: { creditCents: 2000, feeCents: 0 },
    });
  });
});

class FakeReturnRepository implements DropshipReturnRepository {
  lastListInput: Parameters<DropshipReturnRepository["listRmas"]>[0] | null = null;
  lastCreateInput: (CreateDropshipRmaInput & { requestHash: string; now: Date }) | null = null;
  lastStatusInput: (UpdateDropshipRmaStatusInput & { requestHash: string; now: Date }) | null = null;
  lastInspectionInput: (ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date }) | null = null;
  nextStatusReplay = false;

  async listRmas(input: Parameters<DropshipReturnRepository["listRmas"]>[0]): Promise<DropshipRmaListResult> {
    this.lastListInput = input;
    return { items: [makeRma()], total: 1, page: input.page, limit: input.limit };
  }

  async getRma(): Promise<DropshipRmaDetail | null> {
    return makeRmaDetail();
  }

  async createRma(input: CreateDropshipRmaInput & { requestHash: string; now: Date }): Promise<{
    rma: DropshipRmaDetail;
    idempotentReplay: boolean;
  }> {
    this.lastCreateInput = input;
    return { rma: makeRmaDetail({ rmaNumber: input.rmaNumber }), idempotentReplay: false };
  }

  async updateStatus(input: UpdateDropshipRmaStatusInput & { requestHash: string; now: Date }): Promise<DropshipRmaStatusUpdateResult> {
    this.lastStatusInput = input;
    return {
      rma: makeRmaDetail({ status: input.status }),
      idempotentReplay: this.nextStatusReplay,
    };
  }

  async processInspection(
    input: ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date },
  ): Promise<DropshipRmaInspectionResult> {
    this.lastInspectionInput = input;
    const ledgerType = input.faultCategory === "carrier" ? "insurance_pool_credit" : "return_credit";
    const walletLedger = input.creditCents > 0
      ? [{
          ledgerEntryId: 99,
          walletAccountId: 5,
          vendorId: 10,
          type: ledgerType,
          status: "settled" as const,
          amountCents: input.creditCents,
          currency: "USD",
          availableBalanceAfterCents: 2000,
          pendingBalanceAfterCents: 0,
          referenceType: "dropship_rma",
          referenceId: `${input.rmaId}:credit`,
          idempotencyKey: "ledger-idem",
          fundingMethodId: null,
          externalTransactionId: null,
          metadata: {},
          createdAt: input.now,
          settledAt: input.now,
        }]
      : [];
    return {
      rma: makeRmaDetail({ status: walletLedger.length ? "credited" : "approved", walletLedger }),
      inspection: {
        rmaInspectionId: 7,
        rmaId: input.rmaId,
        outcome: input.outcome,
        faultCategory: input.faultCategory,
        notes: input.notes ?? null,
        photos: input.photos,
        creditCents: input.creditCents,
        feeCents: input.feeCents,
        inspectedBy: input.actor.actorId ?? null,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      },
      walletLedger,
      idempotentReplay: false,
    };
  }
}

class FakeVendorProvisioningService {
  async provisionForMember(memberId: string): Promise<DropshipProvisionVendorRepositoryResult> {
    return {
      vendor: makeVendor({ memberId }),
      created: false,
      changedFields: [],
    };
  }
}

function makeService(repository: DropshipReturnRepository, logs: DropshipLogEvent[]): DropshipReturnService {
  return new DropshipReturnService({
    vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  });
}

function makeRma(overrides: Partial<DropshipRmaDetail> = {}): DropshipRmaDetail {
  return {
    rmaId: 1,
    rmaNumber: "RMA-1",
    vendorId: 10,
    vendorName: null,
    vendorEmail: "vendor@cardshellz.test",
    storeConnectionId: null,
    platform: null,
    intakeId: null,
    omsOrderId: null,
    status: "requested",
    reasonCode: null,
    faultCategory: null,
    returnWindowDays: 30,
    returnTrackingNumber: null,
    requestedAt: now,
    receivedAt: null,
    inspectedAt: null,
    creditedAt: null,
    updatedAt: now,
    itemCount: 1,
    totalQuantity: 1,
    labelSource: null,
    vendorNotes: null,
    idempotencyKey: null,
    requestHash: null,
    items: [],
    inspections: [],
    walletLedger: [],
    ...overrides,
  };
}

function makeRmaDetail(overrides: Partial<DropshipRmaDetail> = {}): DropshipRmaDetail {
  return makeRma(overrides);
}

function makeVendor(overrides: Partial<DropshipProvisionedVendorProfile> = {}): DropshipProvisionedVendorProfile {
  return {
    vendorId: 10,
    memberId: "member-1",
    currentSubscriptionId: "sub-1",
    currentPlanId: "ops",
    businessName: null,
    contactName: null,
    email: "vendor@cardshellz.test",
    phone: null,
    status: "active",
    entitlementStatus: "active",
    entitlementCheckedAt: now,
    membershipGraceEndsAt: null,
    includedStoreConnections: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
