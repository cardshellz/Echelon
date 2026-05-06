import { describe, expect, it } from "vitest";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import {
  DropshipReturnService,
  type CreateDropshipRmaInput,
  type DropshipReturnRepository,
  type DropshipRmaDetail,
  type DropshipRmaInspectionResult,
  type DropshipRmaListResult,
  type DropshipRmaOrderReference,
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

  it("creates member-scoped RMAs without trusting vendor or policy fields from the portal", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.createRmaForMember("member-1", {
      rmaNumber: "RMA-VENDOR-100",
      intakeId: 44,
      reasonCode: "buyer_return",
      faultCategory: "marketplace",
      labelSource: "vendor",
      returnTrackingNumber: "9400",
      vendorNotes: "Buyer return opened in marketplace.",
      items: [{ productVariantId: 20, quantity: 1, requestedCreditCents: 1500 }],
      idempotencyKey: "vendor-rma-100",
    });

    expect(result.rma.rmaNumber).toBe("RMA-VENDOR-100");
    expect(repository.lastOrderReferenceInput).toEqual({ vendorId: 10, intakeId: 44 });
    expect(repository.lastCreateInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 70,
      omsOrderId: 9001,
      rmaNumber: "RMA-VENDOR-100",
      returnWindowDays: 30,
      idempotencyKey: "vendor-rma-100",
      actor: { actorType: "vendor", actorId: "member-1" },
    });
    expect(repository.lastCreateInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_RMA_CREATED" });

    await expect(service.createRmaForMember("member-1", {
      vendorId: 99,
      rmaNumber: "RMA-SPOOFED",
      returnWindowDays: 365,
      storeConnectionId: 70,
      omsOrderId: 9001,
      items: [],
      idempotencyKey: "vendor-rma-spoof",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("rejects vendor RMA item variants that are not proven by the linked order", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await expect(service.createRmaForMember("member-1", {
      rmaNumber: "RMA-NO-ORDER",
      items: [{ productVariantId: 20, quantity: 1 }],
      idempotencyKey: "vendor-rma-no-order",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(service.createRmaForMember("member-1", {
      rmaNumber: "RMA-BAD-VARIANT",
      intakeId: 44,
      items: [{ productVariantId: 999, quantity: 1 }],
      idempotencyKey: "vendor-rma-bad-variant",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(service.createRmaForMember("member-1", {
      rmaNumber: "RMA-OVER-QTY",
      intakeId: 44,
      items: [{ productVariantId: 20, quantity: 4 }],
      idempotencyKey: "vendor-rma-over-qty",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    expect(repository.lastCreateInput?.rmaNumber).not.toBe("RMA-OVER-QTY");
  });

  it("rejects member RMA references to orders outside the vendor scope", async () => {
    const repository = new FakeReturnRepository();
    repository.orderReference = null;
    const service = makeService(repository, []);

    await expect(service.createRmaForMember("member-1", {
      rmaNumber: "RMA-MISSING-ORDER",
      intakeId: 55,
      items: [],
      idempotencyKey: "vendor-rma-missing-order",
    })).rejects.toMatchObject({ code: "DROPSHIP_ORDER_INTAKE_NOT_FOUND" });
  });

  it("creates RMAs with idempotency, request hash, actor, and clock context", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const notificationSender = new FakeNotificationSender();
    const service = makeService(repository, logs, notificationSender);

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
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_rma_opened",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship RMA opened",
      idempotencyKey: "rma-opened:1",
      payload: {
        rmaId: 1,
        rmaNumber: "RMA-100",
        status: "requested",
      },
    });
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
    const notificationSender = new FakeNotificationSender();
    const service = makeService(repository, logs, notificationSender);

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
    expect(notificationSender.sent[0]).toMatchObject({
      vendorId: 10,
      eventType: "dropship_return_credit_posted",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship return credit posted",
      idempotencyKey: "rma-credit-posted:1:7",
      payload: {
        rmaId: 1,
        inspectionId: 7,
        creditCents: 2000,
        walletLedgerIds: [99],
      },
    });
  });

  it("does not notify return credit when inspection posts no wallet credit", async () => {
    const repository = new FakeReturnRepository();
    const notificationSender = new FakeNotificationSender();
    const service = makeService(repository, [], notificationSender);

    await service.processInspection({
      rmaId: 1,
      outcome: "rejected",
      faultCategory: "customer",
      creditCents: 0,
      feeCents: 0,
      items: [],
      idempotencyKey: "inspect-rma-no-credit",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(notificationSender.sent).toHaveLength(0);
  });

  it("logs notification failures without undoing RMA creation", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const notificationSender = new FakeNotificationSender(new Error("email unavailable"));
    const service = makeService(repository, logs, notificationSender);

    const result = await service.createRma({
      vendorId: 10,
      rmaNumber: "RMA-FAIL-NOTIFY",
      returnWindowDays: 30,
      items: [],
      idempotencyKey: "create-rma-notify-fail",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.rma.rmaNumber).toBe("RMA-FAIL-NOTIFY");
    expect(notificationSender.sent).toHaveLength(1);
    expect(logs.some((event) => (
      event.code === "DROPSHIP_RMA_OPENED_NOTIFICATION_FAILED"
        && event.context?.rmaId === 1
    ))).toBe(true);
  });
});

class FakeReturnRepository implements DropshipReturnRepository {
  lastListInput: Parameters<DropshipReturnRepository["listRmas"]>[0] | null = null;
  lastCreateInput: (CreateDropshipRmaInput & { requestHash: string; now: Date }) | null = null;
  lastStatusInput: (UpdateDropshipRmaStatusInput & { requestHash: string; now: Date }) | null = null;
  lastInspectionInput: (ProcessDropshipRmaInspectionInput & { requestHash: string; now: Date }) | null = null;
  lastOrderReferenceInput: Parameters<DropshipReturnRepository["getOrderReference"]>[0] | null = null;
  orderReference: DropshipRmaOrderReference | null = makeOrderReference();
  nextStatusReplay = false;

  async listRmas(input: Parameters<DropshipReturnRepository["listRmas"]>[0]): Promise<DropshipRmaListResult> {
    this.lastListInput = input;
    return { items: [makeRma()], total: 1, page: input.page, limit: input.limit };
  }

  async getRma(): Promise<DropshipRmaDetail | null> {
    return makeRmaDetail();
  }

  async getOrderReference(input: Parameters<DropshipReturnRepository["getOrderReference"]>[0]): Promise<DropshipRmaOrderReference | null> {
    this.lastOrderReferenceInput = input;
    return this.orderReference;
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

class FakeNotificationSender {
  sent: DropshipNotificationSenderInput[] = [];

  constructor(private readonly error: Error | null = null) {}

  async send(input: DropshipNotificationSenderInput): Promise<void> {
    this.sent.push(input);
    if (this.error) {
      throw this.error;
    }
  }
}

function makeService(
  repository: DropshipReturnRepository,
  logs: DropshipLogEvent[],
  notificationSender?: FakeNotificationSender,
): DropshipReturnService {
  return new DropshipReturnService({
    vendorProvisioning: new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    notificationSender,
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

function makeOrderReference(overrides: Partial<DropshipRmaOrderReference> = {}): DropshipRmaOrderReference {
  return {
    intakeId: 44,
    storeConnectionId: 70,
    omsOrderId: 9001,
    lines: [
      { lineIndex: 0, productVariantId: 20, quantity: 2 },
      { lineIndex: 1, productVariantId: 21, quantity: 1 },
    ],
    ...overrides,
  };
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
