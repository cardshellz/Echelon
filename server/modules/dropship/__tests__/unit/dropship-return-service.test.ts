import { describe, expect, it } from "vitest";
import type {
  DropshipLogEvent,
  DropshipNotificationSenderInput,
} from "../../application/dropship-ports";
import {
  DropshipReturnService,
  type DropshipReturnPolicyMutationResult,
  type DropshipReturnPolicyRecord,
  type DropshipReturnRepository,
  type DropshipRmaDetail,
  type DropshipRmaInspectionResult,
  type DropshipRmaListResult,
  type DropshipRmaOrderEconomics,
  type DropshipRmaOrderReference,
  type DropshipRmaStatusUpdateResult,
  type NormalizedProcessDropshipRmaInspectionInput,
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

    await service.listForMember("member-1", {
      statuses: ["credited"],
      page: 2,
      limit: 10,
    });

    expect(repository.lastListInput).toMatchObject({
      vendorId: 10,
      statuses: ["credited"],
      page: 2,
      limit: 10,
    });
  });

  it("returns a vendor-scoped source order reference for administrators", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    const result = await service.getOrderReferenceForAdmin({
      vendorId: 10,
      intakeId: 44,
    });

    expect(repository.lastOrderReferenceInput).toEqual({
      vendorId: 10,
      intakeId: 44,
    });
    expect(result).toEqual(makeOrderReference());
  });

  it("rejects missing vendor-scoped source order references", async () => {
    const repository = new FakeReturnRepository();
    repository.orderReference = null;
    const service = makeService(repository, []);

    await expect(service.getOrderReferenceForAdmin({
      vendorId: 10,
      intakeId: 44,
    })).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
      context: { vendorId: 10, intakeId: 44 },
    });
  });

  it("creates member-scoped RMAs without trusting vendor or policy fields from the portal", async () => {
    const repository = new FakeReturnRepository();
    repository.activePolicy = makeReturnPolicy();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.createRmaForMember("member-1", {
      intakeId: 44,
      reasonCode: "buyer_return",
      faultCategory: "marketplace",
      labelSource: "vendor",
      returnTrackingNumber: "9400",
      vendorNotes: "Buyer return opened in marketplace.",
      items: [
        { productVariantId: 20, quantity: 1 },
      ],
      idempotencyKey: "vendor-rma-100",
    });

    expect(result.rma.rmaNumber).toBe("RMA-00000001");
    expect(repository.lastOrderReferenceInput).toEqual({
      vendorId: 10,
      intakeId: 44,
    });
    expect(repository.lastPolicyLookupAt).toEqual(now);
    expect(repository.lastCreateInput).toMatchObject({
      vendorId: 10,
      storeConnectionId: 70,
      omsOrderId: 9001,
      returnWindowDays: 30,
      idempotencyKey: "vendor-rma-100",
      actor: { actorType: "vendor", actorId: "member-1" },
    });
    expect(repository.lastCreateInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(repository.lastCreateInput).not.toHaveProperty("rmaNumber");
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_RMA_CREATED" });

    await expect(
      service.createRmaForMember("member-1", {
        vendorId: 99,
        rmaNumber: "RMA-SPOOFED",
        returnWindowDays: 365,
        storeConnectionId: 70,
        omsOrderId: 9001,
        items: [],
        idempotencyKey: "vendor-rma-spoof",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("rejects vendor-controlled credit terms at the RMA intake boundary", async () => {
    const repository = new FakeReturnRepository();
    repository.activePolicy = makeReturnPolicy();
    const service = makeService(repository, []);

    await expect(service.createRmaForMember("member-1", {
      rmaNumber: "RMA-VENDOR-CREDIT",
      intakeId: 44,
      reasonCode: "buyer_return",
      faultCategory: "marketplace",
      labelSource: "vendor",
      returnTrackingNumber: "9400",
      vendorNotes: null,
      items: [
        {
          productVariantId: 20,
          quantity: 1,
          requestedCreditCents: 1500,
        },
      ],
      idempotencyKey: "vendor-rma-credit",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
    expect(repository.lastCreateInput).toBeNull();
  });

  it("uses the active return policy window for member RMA enforcement", async () => {
    const repository = new FakeReturnRepository();
    repository.activePolicy = makeReturnPolicy({ returnWindowDays: 45 });
    repository.orderReference = makeOrderReference({
      acceptedAt: new Date("2026-04-01T19:00:00.000Z"),
    });
    const service = makeService(repository, []);

    await service.createRmaForMember("member-1", {
      rmaNumber: "RMA-POLICY-WINDOW",
      intakeId: 44,
      items: [{ productVariantId: 20, quantity: 1 }],
      idempotencyKey: "vendor-rma-policy-window",
    });

    expect(repository.lastCreateInput).toMatchObject({ returnWindowDays: 45 });
    expect(repository.lastCreateInput).not.toHaveProperty("rmaNumber");
  });

  it("rejects member RMAs when no active return policy is configured", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-NO-POLICY",
        intakeId: 44,
        items: [{ productVariantId: 20, quantity: 1 }],
        idempotencyKey: "vendor-rma-no-policy",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_POLICY_REQUIRED",
      context: {
        vendorId: 10,
        intakeId: 44,
        at: now.toISOString(),
      },
    });
    expect(repository.lastPolicyLookupAt).toEqual(now);
    expect(repository.lastCreateInput).toBeNull();
  });

  it("rejects vendor RMA item variants that are not proven by the linked order", async () => {
    const repository = new FakeReturnRepository();
    repository.activePolicy = makeReturnPolicy();
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-NO-ORDER",
        items: [{ productVariantId: 20, quantity: 1 }],
        idempotencyKey: "vendor-rma-no-order",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-BAD-VARIANT",
        intakeId: 44,
        items: [{ productVariantId: 999, quantity: 1 }],
        idempotencyKey: "vendor-rma-bad-variant",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-OVER-QTY",
        intakeId: 44,
        items: [{ productVariantId: 20, quantity: 4 }],
        idempotencyKey: "vendor-rma-over-qty",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    expect(repository.lastCreateInput).toBeNull();
  });

  it("rejects member RMAs without a linked accepted order intake", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-MISSING-LINK",
        items: [],
        idempotencyKey: "vendor-rma-missing-link",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
    expect(repository.lastOrderReferenceInput).toBeNull();
    expect(repository.lastCreateInput).toBeNull();
  });

  it("rejects member RMA references to unaccepted order intake", async () => {
    const repository = new FakeReturnRepository();
    repository.orderReference = makeOrderReference({
      status: "payment_hold",
      omsOrderId: null,
    });
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-UNACCEPTED",
        intakeId: 44,
        items: [{ productVariantId: 20, quantity: 1 }],
        idempotencyKey: "vendor-rma-unaccepted",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT",
      context: {
        intakeId: 44,
        status: "payment_hold",
        omsOrderId: null,
      },
    });
    expect(repository.lastCreateInput).toBeNull();
  });

  it("rejects member RMA references outside the return window", async () => {
    const repository = new FakeReturnRepository();
    repository.activePolicy = makeReturnPolicy();
    repository.orderReference = makeOrderReference({
      acceptedAt: new Date("2026-04-01T18:59:59.999Z"),
    });
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-EXPIRED",
        intakeId: 44,
        items: [{ productVariantId: 20, quantity: 1 }],
        idempotencyKey: "vendor-rma-expired",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_WINDOW_EXPIRED",
      context: {
        intakeId: 44,
        acceptedAt: "2026-04-01T18:59:59.999Z",
        returnWindowDays: 30,
        expiredAt: "2026-05-01T18:59:59.999Z",
        now: now.toISOString(),
      },
    });
    expect(repository.lastCreateInput).toBeNull();
  });

  it("creates configurable return policies with idempotency and audit context", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);
    const effectiveFrom = new Date("2026-05-02T00:00:00.000Z");

    const result = await service.createReturnPolicy({
      name: "Ops 45 day returns",
      returnWindowDays: 45,
      effectiveFrom,
      idempotencyKey: "return-policy-45-days",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.policy).toMatchObject({
      policyId: 31,
      name: "Ops 45 day returns",
      returnWindowDays: 45,
      isActive: true,
    });
    expect(repository.lastReturnPolicyInput).toMatchObject({
      name: "Ops 45 day returns",
      returnWindowDays: 45,
      isActive: true,
      effectiveFrom,
      effectiveTo: null,
      idempotencyKey: "return-policy-45-days",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });
    expect(repository.lastReturnPolicyInput?.requestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(logs[0]).toMatchObject({
      code: "DROPSHIP_RETURN_POLICY_CREATED",
      context: {
        policyId: 31,
        returnWindowDays: 45,
        idempotencyKey: "return-policy-45-days",
      },
    });
  });

  it("rejects return policy windows with invalid effective dates", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);

    await expect(
      service.createReturnPolicy({
        name: "Invalid return policy",
        returnWindowDays: 30,
        effectiveFrom: "2026-05-03T00:00:00.000Z",
        effectiveTo: "2026-05-03T00:00:00.000Z",
        idempotencyKey: "return-policy-invalid-window",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_POLICY_INVALID_INPUT",
      context: {
        effectiveFrom: "2026-05-03T00:00:00.000Z",
        effectiveTo: "2026-05-03T00:00:00.000Z",
      },
    });
    expect(repository.lastReturnPolicyInput).toBeNull();
  });

  it("rejects member RMA references to orders outside the vendor scope", async () => {
    const repository = new FakeReturnRepository();
    repository.orderReference = null;
    const service = makeService(repository, []);

    await expect(
      service.createRmaForMember("member-1", {
        rmaNumber: "RMA-MISSING-ORDER",
        intakeId: 55,
        items: [],
        idempotencyKey: "vendor-rma-missing-order",
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_ORDER_INTAKE_NOT_FOUND" });
  });

  it("creates admin RMAs from exact linked order lines", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const notificationSender = new FakeNotificationSender();
    const service = makeService(repository, logs, notificationSender);

    const result = await service.createRma({
      vendorId: 10,
      rmaNumber: "RMA-100",
      storeConnectionId: 70,
      intakeId: 44,
      omsOrderId: 9001,
      returnWindowDays: 30,
      items: [
        {
          source: "order",
          orderLineIndex: 0,
          externalLineItemId: "line-20",
          productVariantId: 20,
          quantity: 2,
        },
      ],
      idempotencyKey: "create-rma-100",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.rma.rmaNumber).toBe("RMA-00000001");
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
        rmaNumber: "RMA-00000001",
        status: "requested",
      },
    });
  });

  it("rejects uncontrolled admin reason and label values", async () => {
    const service = makeService(new FakeReturnRepository(), []);
    const base = {
      vendorId: 10,
      rmaNumber: "RMA-CONTROLLED-FIELDS",
      returnWindowDays: 30,
      items: [{
        source: "manual_exception" as const,
        quantity: 1,
        manualDescription: "Unmapped marketplace item",
        exceptionReason: "Marketplace line was absent from intake payload",
      }],
      actor: { actorType: "admin" as const, actorId: "admin-1" },
    };

    await expect(service.createRma({
      ...base,
      reasonCode: "free-form-reason",
      idempotencyKey: "admin-rma-invalid-reason",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(service.createRma({
      ...base,
      labelSource: "free-form-label",
      idempotencyKey: "admin-rma-invalid-label",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await expect(service.createRma({
      ...base,
      returnTrackingNumber: "1Z999",
      idempotencyKey: "admin-rma-tracking-without-label",
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("rejects empty administrator-created RMAs", async () => {
    const service = makeService(new FakeReturnRepository(), []);

    await expect(
      service.createRma({
        vendorId: 10,
        rmaNumber: "RMA-NO-ITEMS",
        returnWindowDays: 30,
        items: [],
        idempotencyKey: "admin-rma-no-items",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("rejects fabricated, duplicate, or excessive admin order-line returns", async () => {
    const service = makeService(new FakeReturnRepository(), []);
    const base = {
      vendorId: 10,
      storeConnectionId: 70,
      intakeId: 44,
      omsOrderId: 9001,
      rmaNumber: "RMA-INVALID-LINE",
      returnWindowDays: 30,
      idempotencyKey: "admin-rma-invalid-line",
      actor: { actorType: "admin" as const, actorId: "admin-1" },
    };

    await expect(service.createRma({
      ...base,
      items: [{ source: "order", orderLineIndex: 99, productVariantId: 20, quantity: 1 }],
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
    await expect(service.createRma({
      ...base,
      idempotencyKey: "admin-rma-wrong-variant",
      items: [{ source: "order", orderLineIndex: 0, productVariantId: 21, quantity: 1 }],
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
    await expect(service.createRma({
      ...base,
      idempotencyKey: "admin-rma-over-quantity",
      items: [{ source: "order", orderLineIndex: 0, productVariantId: 20, quantity: 3 }],
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
    await expect(service.createRma({
      ...base,
      idempotencyKey: "admin-rma-duplicate-line",
      items: [
        { source: "order", orderLineIndex: 0, productVariantId: 20, quantity: 1 },
        { source: "order", orderLineIndex: 0, productVariantId: 20, quantity: 1 },
      ],
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("requires audited, identifiable manual exceptions for admin RMAs", async () => {
    const repository = new FakeReturnRepository();
    const service = makeService(repository, []);
    const base = {
      vendorId: 10,
      rmaNumber: "RMA-MANUAL",
      returnWindowDays: 30,
      idempotencyKey: "admin-rma-manual",
      actor: { actorType: "admin" as const, actorId: "admin-1" },
    };

    await expect(service.createRma({
      ...base,
      items: [{ source: "manual_exception", quantity: 1, exceptionReason: "Not on order" }],
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });

    await service.createRma({
      ...base,
      items: [{
        source: "manual_exception",
        quantity: 1,
        manualDescription: "Unmapped marketplace bonus item",
        exceptionReason: "Marketplace line was absent from intake payload",
      }],
    });
    expect(repository.lastCreateInput?.items[0]).toMatchObject({
      source: "manual_exception",
      manualDescription: "Unmapped marketplace bonus item",
      exceptionReason: "Marketplace line was absent from intake payload",
      status: "requested",
    });
  });

  it("rejects legacy item rows on administrator-created RMAs", async () => {
    const service = makeService(new FakeReturnRepository(), []);
    await expect(service.createRma({
      vendorId: 10,
      rmaNumber: "RMA-LEGACY",
      returnWindowDays: 30,
      items: [{ productVariantId: 20, quantity: 1 }],
      idempotencyKey: "admin-rma-legacy",
      actor: { actorType: "admin", actorId: "admin-1" },
    })).rejects.toMatchObject({ code: "DROPSHIP_RETURN_CREATE_INVALID_INPUT" });
  });

  it("updates status with idempotency, request hash, actor, and clock context", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "in_transit";
    const logs: DropshipLogEvent[] = [];
    const service = makeService(repository, logs);

    const result = await service.updateStatus({
      rmaId: 1,
      status: "received",
      notes: "return arrived",
      idempotencyKey: "status-rma-1",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result).toMatchObject({
      idempotentReplay: false,
      rma: { status: "received" },
    });
    expect(repository.lastStatusInput).toMatchObject({
      rmaId: 1,
      status: "received",
      notes: "return arrived",
      idempotencyKey: "status-rma-1",
      policyVersionId: 41,
      now,
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(repository.lastStatusInput?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(logs[0]).toMatchObject({ code: "DROPSHIP_RMA_STATUS_UPDATED" });
  });

  it("rejects illegal status transitions with DROPSHIP_RMA_ILLEGAL_TRANSITION", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "requested";
    const service = makeService(repository, []);

    await expect(
      service.updateStatus({
        rmaId: 1,
        status: "received",
        idempotencyKey: "status-rma-skip",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RMA_ILLEGAL_TRANSITION",
      context: {
        from: "requested",
        to: "received",
        violation: "illegal_transition",
      },
    });
    expect(repository.lastStatusInput).toBeNull();
  });

  it("rejects admin attempts to write credited directly (system post-ledger only)", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "approved";
    const service = makeService(repository, []);

    await expect(
      service.updateStatus({
        rmaId: 1,
        status: "credited",
        idempotencyKey: "status-rma-credit",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RMA_ILLEGAL_TRANSITION",
      context: {
        from: "approved",
        to: "credited",
        violation: "credited_requires_system_ledger",
      },
    });
    expect(repository.lastStatusInput).toBeNull();
  });

  it("requires a reason for inspecting -> rejected", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "inspecting";
    const service = makeService(repository, []);

    await expect(
      service.updateStatus({
        rmaId: 1,
        status: "rejected",
        idempotencyKey: "status-rma-reject",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RMA_ILLEGAL_TRANSITION",
      context: {
        from: "inspecting",
        to: "rejected",
        violation: "reason_required",
      },
    });
    expect(repository.lastStatusInput).toBeNull();
  });

  it("does not duplicate service logs for idempotent status update replay", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "received";
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

    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        creditCents: 1000,
        feeCents: 100,
        overrideReason: "manual disposition",
        items: [{ rmaItemId: 1, finalCreditCents: 900, feeCents: 100 }],
        idempotencyKey: "inspect-rma-1",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT",
    });
    expect(repository.lastInspectionInput).toBeNull();
  });

  it("requires an override reason when partially overriding the computed settlement", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const service = makeService(
      repository,
      [],
      undefined,
      new FakeReturnPolicyService(),
    );

    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        creditCents: 1000,
        items: [{ rmaItemId: 1 }],
        idempotencyKey: "inspect-rma-no-reason",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_INSPECTION_INVALID_INPUT",
    });
    expect(repository.lastInspectionInput).toBeNull();
  });

  it("rejects inspections when the RMA is not in inspecting status (D4)", async () => {
    const repository = new FakeReturnRepository();
    repository.rmaStatus = "requested";
    const service = makeService(repository, []);

    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        creditCents: 1000,
        feeCents: 100,
        overrideReason: "manual disposition",
        items: [{ rmaItemId: 1, finalCreditCents: 1000, feeCents: 100 }],
        idempotencyKey: "inspect-rma-wrong-state",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RMA_ILLEGAL_TRANSITION",
      context: {
        from: "requested",
        to: "approved",
        violation: "illegal_transition",
      },
    });
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
      overrideReason: "carrier claim approved by ops",
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
    expect(repository.lastInspectionInput?.settlement).toMatchObject({
      creditLedgerType: "insurance_pool_credit",
      policyVersionId: 41,
      overrideReason: "carrier claim approved by ops",
    });
    expect(repository.lastInspectionInput?.requestHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
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
      notes: "item destroyed by customer",
      items: [],
      idempotencyKey: "inspect-rma-no-credit",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(notificationSender.sent).toHaveLength(0);
  });

  it("logs notification failures without undoing RMA creation", async () => {
    const repository = new FakeReturnRepository();
    const logs: DropshipLogEvent[] = [];
    const notificationSender = new FakeNotificationSender(
      new Error("email unavailable"),
    );
    const service = makeService(repository, logs, notificationSender);

    const result = await service.createRma({
      vendorId: 10,
      rmaNumber: "RMA-FAIL-NOTIFY",
      returnWindowDays: 30,
      items: [{
        source: "manual_exception",
        quantity: 1,
        manualDescription: "Unmapped returned item",
        exceptionReason: "Notification failure test fixture",
      }],
      idempotencyKey: "create-rma-notify-fail",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(result.rma.rmaNumber).toBe("RMA-00000001");
    expect(notificationSender.sent).toHaveLength(1);
    expect(
      logs.some(
        (event) =>
          event.code === "DROPSHIP_RMA_OPENED_NOTIFICATION_FAILED" &&
          event.context?.rmaId === 1,
      ),
    ).toBe(true);
  });

  it("computes the inspection settlement via the fee engine when no override is given", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const policyService = new FakeReturnPolicyService();
    policyService.fees = {
      restockingFee: { feeId: 51, amountType: "flat_cents", amount: 300 },
      processingFee: { feeId: 52, amountType: "percent", amount: 10 },
      returnShippingFee: { feeId: 53, amountType: "flat_cents", amount: 0 },
    };
    const service = makeService(repository, [], undefined, policyService);

    const result = await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "customer",
      returnShippingActualCents: 650,
      items: [{ rmaItemId: 1 }],
      idempotencyKey: "inspect-rma-engine",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    // product credit = 2 units * 1000 = 2000; customer fault: no original
    // shipping credit; fees = 300 flat + 10% of 2000 (200) + 650 label.
    expect(repository.lastInspectionInput).toMatchObject({
      rmaId: 1,
      creditCents: 2_000,
      feeCents: 1_150,
    });
    expect(repository.lastInspectionInput?.settlement).toMatchObject({
      creditLedgerType: "return_credit",
      policyVersionId: 41,
      overrideReason: null,
    });
    const breakdown = repository.lastInspectionInput?.settlement
      .breakdown as Record<string, unknown>;
    expect(breakdown).toMatchObject({
      version: 1,
      mode: "computed",
      faultCategory: "customer",
      productCreditCents: 2_000,
      totalFeeCents: 1_150,
      netSettlementCents: 850,
    });
    expect(repository.lastInspectionInput?.items).toEqual([
      {
        rmaItemId: 1,
        status: "resellable",
        finalCreditCents: 2_000,
        feeCents: 1_150,
      },
    ]);
    expect(result.walletLedger[0]).toMatchObject({
      type: "return_credit",
      amountCents: 2_000,
    });
  });

  it("applies mixed fee responsibilities and persists the selected policy audit", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const policyService = new FakeReturnPolicyService();
    policyService.defaultFees = makeResolvedFees({
      restockingFee: makeFee(
        61,
        "restocking_fee",
        "customer",
        "flat_cents",
        250,
      ),
      processingFee: makeFee(
        62,
        "processing_fee",
        "card_shellz",
        "percent",
        10,
      ),
      returnShippingFee: makeFee(
        63,
        "return_shipping_fee",
        "carrier",
        "flat_cents",
        0,
      ),
    });
    policyService.feesByResponsibility.set(
      "vendor",
      makeResolvedFees({
        restockingFee: makeFee(
          71,
          "restocking_fee",
          "vendor",
          "flat_cents",
          300,
        ),
      }),
    );
    policyService.feesByResponsibility.set(
      "card_shellz",
      makeResolvedFees({
        processingFee: makeFee(
          72,
          "processing_fee",
          "card_shellz",
          "percent",
          10,
        ),
      }),
    );
    policyService.feesByResponsibility.set(
      "carrier",
      makeResolvedFees({
        returnShippingFee: makeFee(
          73,
          "return_shipping_fee",
          "carrier",
          "flat_cents",
          0,
        ),
      }),
    );
    const service = makeService(repository, [], undefined, policyService);

    await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "customer",
      returnShippingActualCents: 650,
      items: [{ rmaItemId: 1 }],
      feeDecisions: [
        {
          feeType: "restocking_fee",
          responsibility: "vendor",
          amountCents: 300,
          overrideReason: "Vendor accepted restocking responsibility.",
        },
        {
          feeType: "processing_fee",
          responsibility: "card_shellz",
          amountCents: 0,
        },
        {
          feeType: "return_shipping_fee",
          responsibility: "carrier",
          amountCents: 0,
        },
      ],
      idempotencyKey: "inspect-rma-mixed-fees",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(repository.lastInspectionInput).toMatchObject({
      creditCents: 2_000,
      feeCents: 300,
    });
    expect(
      policyService.resolveCalls.map((call) => call.faultCategory),
    ).toEqual(["vendor", "card_shellz", "carrier"]);
    const breakdown = repository.lastInspectionInput?.settlement
      .breakdown as Record<string, unknown>;
    expect(breakdown.feeDecisions).toEqual([
      expect.objectContaining({
        feeType: "restocking_fee",
        defaultResponsibility: "customer",
        selectedResponsibility: "vendor",
        defaultPolicyFeeId: 61,
        selectedPolicyFeeId: 71,
        expectedAmountCents: 300,
        amountCents: 300,
      }),
      expect.objectContaining({
        feeType: "processing_fee",
        defaultResponsibility: "card_shellz",
        selectedResponsibility: "card_shellz",
        selectedPolicyFeeId: 72,
        expectedAmountCents: 0,
        amountCents: 0,
      }),
      expect.objectContaining({
        feeType: "return_shipping_fee",
        defaultResponsibility: "carrier",
        selectedResponsibility: "carrier",
        selectedPolicyFeeId: 73,
        expectedAmountCents: 0,
        amountCents: 0,
      }),
    ]);
  });

  it("requires an audit reason when fee responsibility differs from the policy default", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const service = makeService(
      repository,
      [],
      undefined,
      configuredDecisionPolicyService(),
    );
    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        items: [{ rmaItemId: 1 }],
        feeDecisions: [
          {
            feeType: "restocking_fee",
            responsibility: "vendor",
            amountCents: 300,
          },
          {
            feeType: "processing_fee",
            responsibility: "card_shellz",
            amountCents: 0,
          },
          {
            feeType: "return_shipping_fee",
            responsibility: "carrier",
            amountCents: 0,
          },
        ],
        idempotencyKey: "inspect-rma-responsibility-no-reason",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_FEE_OVERRIDE_REASON_REQUIRED",
      context: { feeType: "restocking_fee" },
    });
    expect(repository.lastInspectionInput).toBeNull();
  });

  it("requires an audit reason when a fee amount differs from the computed policy amount", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const service = makeService(
      repository,
      [],
      undefined,
      configuredDecisionPolicyService({
        restockingDefaultResponsibility: "vendor",
      }),
    );
    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        items: [{ rmaItemId: 1 }],
        feeDecisions: [
          {
            feeType: "restocking_fee",
            responsibility: "vendor",
            amountCents: 301,
          },
          {
            feeType: "processing_fee",
            responsibility: "card_shellz",
            amountCents: 0,
          },
          {
            feeType: "return_shipping_fee",
            responsibility: "carrier",
            amountCents: 0,
          },
        ],
        idempotencyKey: "inspect-rma-amount-no-reason",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_RETURN_FEE_OVERRIDE_REASON_REQUIRED",
      context: {
        feeType: "restocking_fee",
        expectedAmountCents: 300,
        selectedAmountCents: 301,
      },
    });
    expect(repository.lastInspectionInput).toBeNull();
  });

  it("accepts policy-default fee decisions without override reasons", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const service = makeService(
      repository,
      [],
      undefined,
      configuredDecisionPolicyService({
        restockingDefaultResponsibility: "vendor",
      }),
    );
    await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "customer",
      items: [{ rmaItemId: 1 }],
      feeDecisions: [
        {
          feeType: "restocking_fee",
          responsibility: "vendor",
          amountCents: 300,
        },
        {
          feeType: "processing_fee",
          responsibility: "card_shellz",
          amountCents: 0,
        },
        {
          feeType: "return_shipping_fee",
          responsibility: "carrier",
          amountCents: 0,
        },
      ],
      idempotencyKey: "inspect-rma-policy-fees",
      actor: { actorType: "admin", actorId: "admin-1" },
    });
    expect(repository.lastInspectionInput).toMatchObject({
      creditCents: 2_000,
      feeCents: 300,
    });
  });

  it("engine path: card_shellz fault credits product + original shipping with no fees", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const policyService = new FakeReturnPolicyService();
    const service = makeService(repository, [], undefined, policyService);

    await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "card_shellz",
      items: [{ rmaItemId: 1 }],
      idempotencyKey: "inspect-rma-engine-cs",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    expect(repository.lastInspectionInput).toMatchObject({
      creditCents: 2_800, // 2000 product + 800 original shipping
      feeCents: 0,
    });
  });

  it("engine path: netting allows a negative remainder (D5, no hard fail)", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const policyService = new FakeReturnPolicyService();
    policyService.fees = {
      restockingFee: { feeId: 51, amountType: "flat_cents", amount: 5_000 },
      processingFee: null,
      returnShippingFee: { feeId: 53, amountType: "flat_cents", amount: 0 },
    };
    const service = makeService(repository, [], undefined, policyService);

    await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "vendor",
      returnShippingActualCents: 700,
      items: [{ rmaItemId: 1 }],
      idempotencyKey: "inspect-rma-engine-negative",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    // credit 2000 - fees (5000 + 700) = -3700 remainder; no throw.
    expect(repository.lastInspectionInput).toMatchObject({
      creditCents: 2_000,
      feeCents: 5_700,
    });
    const breakdown = repository.lastInspectionInput?.settlement
      .breakdown as Record<string, unknown>;
    expect(breakdown).toMatchObject({ netSettlementCents: -3_700 });
  });

  it("engine path: rejected items are excluded from the accepted credit basis", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = makeOrderEconomics();
    const policyService = new FakeReturnPolicyService();
    const service = makeService(repository, [], undefined, policyService);

    await service.processInspection({
      rmaId: 1,
      outcome: "approved",
      faultCategory: "card_shellz",
      items: [{ rmaItemId: 1, status: "rejected" }],
      idempotencyKey: "inspect-rma-engine-rejected-item",
      actor: { actorType: "admin", actorId: "admin-1" },
    });

    // item rejected -> no accepted lines -> product credit 0; card_shellz
    // still credits original shipping.
    expect(repository.lastInspectionInput).toMatchObject({
      creditCents: 800,
      feeCents: 0,
    });
  });

  it("engine path: fails closed when the economics snapshot is missing", async () => {
    const repository = new FakeReturnRepository();
    repository.economics = null;
    const policyService = new FakeReturnPolicyService();
    const service = makeService(repository, [], undefined, policyService);

    await expect(
      service.processInspection({
        rmaId: 1,
        outcome: "approved",
        faultCategory: "customer",
        items: [{ rmaItemId: 1 }],
        idempotencyKey: "inspect-rma-no-econ",
        actor: { actorType: "admin", actorId: "admin-1" },
      }),
    ).rejects.toMatchObject({ code: "DROPSHIP_RETURN_ECONOMICS_NOT_FOUND" });
    expect(repository.lastInspectionInput).toBeNull();
  });
});

class FakeReturnRepository implements DropshipReturnRepository {
  lastListInput: Parameters<DropshipReturnRepository["listRmas"]>[0] | null =
    null;
  lastCreateInput:
    Parameters<DropshipReturnRepository["createRma"]>[0] | null = null;
  lastStatusInput:
    | (UpdateDropshipRmaStatusInput & {
        policyVersionId: number | null;
        requestHash: string;
        now: Date;
      })
    | null = null;
  lastInspectionInput:
    | (NormalizedProcessDropshipRmaInspectionInput & {
        requestHash: string;
        now: Date;
      })
    | null = null;
  lastOrderReferenceInput:
    Parameters<DropshipReturnRepository["getOrderReference"]>[0] | null = null;
  lastPolicyLookupAt: Date | null = null;
  lastReturnPolicyInput:
    Parameters<DropshipReturnRepository["createReturnPolicy"]>[0] | null = null;
  orderReference: DropshipRmaOrderReference | null = makeOrderReference();
  activePolicy: DropshipReturnPolicyRecord | null = null;
  nextStatusReplay = false;
  rmaStatus: DropshipRmaDetail["status"] = "inspecting";
  rmaItems: DropshipRmaDetail["items"] = [
    {
      rmaItemId: 1,
      rmaId: 1,
      productVariantId: 20,
      source: "order",
      orderLineIndex: 0,
      externalLineItemId: "line-20",
      manualDescription: null,
      exceptionReason: null,
      quantity: 2,
      status: "requested",
      requestedCreditCents: null,
      finalCreditCents: null,
      feeCents: null,
      createdAt: now,
    },
  ];
  economics: DropshipRmaOrderEconomics | null = null;

  async listRmas(
    input: Parameters<DropshipReturnRepository["listRmas"]>[0],
  ): Promise<DropshipRmaListResult> {
    this.lastListInput = input;
    return {
      items: [makeRma()],
      total: 1,
      page: input.page,
      limit: input.limit,
    };
  }

  async getRma(): Promise<DropshipRmaDetail | null> {
    return makeRmaDetail({
      status: this.rmaStatus,
      items: this.rmaItems,
      intakeId: 44,
      storeConnectionId: 70,
    });
  }

  async getOrderReference(
    input: Parameters<DropshipReturnRepository["getOrderReference"]>[0],
  ): Promise<DropshipRmaOrderReference | null> {
    this.lastOrderReferenceInput = input;
    return this.orderReference;
  }

  async getOrderEconomics(): Promise<DropshipRmaOrderEconomics | null> {
    return this.economics;
  }

  async closeNoShipTimedOutRmas(): Promise<{ closedCount: number }> {
    return { closedCount: 0 };
  }

  async getActiveReturnPolicy(
    at: Date,
  ): Promise<DropshipReturnPolicyRecord | null> {
    this.lastPolicyLookupAt = at;
    return this.activePolicy;
  }

  async createReturnPolicy(
    input: Parameters<DropshipReturnRepository["createReturnPolicy"]>[0],
  ): Promise<DropshipReturnPolicyMutationResult> {
    this.lastReturnPolicyInput = input;
    return {
      policy: makeReturnPolicy({
        policyId: 31,
        name: input.name,
        returnWindowDays: input.returnWindowDays,
        isActive: input.isActive,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        createdAt: input.now,
      }),
      idempotentReplay: false,
    };
  }

  async createRma(
    input: Parameters<DropshipReturnRepository["createRma"]>[0],
  ): Promise<{
    rma: DropshipRmaDetail;
    idempotentReplay: boolean;
  }> {
    this.lastCreateInput = input;
    return {
      rma: makeRmaDetail({ rmaNumber: "RMA-00000001" }),
      idempotentReplay: false,
    };
  }

  async updateStatus(
    input: UpdateDropshipRmaStatusInput & {
      policyVersionId: number | null;
      requestHash: string;
      now: Date;
    },
  ): Promise<DropshipRmaStatusUpdateResult> {
    this.lastStatusInput = input;
    return {
      rma: makeRmaDetail({ status: input.status }),
      idempotentReplay: this.nextStatusReplay,
    };
  }

  async processInspection(
    input: NormalizedProcessDropshipRmaInspectionInput & {
      requestHash: string;
      now: Date;
    },
  ): Promise<DropshipRmaInspectionResult> {
    this.lastInspectionInput = input;
    const walletLedger =
      input.creditCents > 0
        ? [
            {
              ledgerEntryId: 99,
              walletAccountId: 5,
              vendorId: 10,
              type: input.settlement.creditLedgerType,
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
            },
          ]
        : [];
    return {
      rma: makeRmaDetail({
        status: input.outcome === "rejected" ? "rejected" : "credited",
        walletLedger,
      }),
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
  async provisionForMember(
    memberId: string,
  ): Promise<DropshipProvisionVendorRepositoryResult> {
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
  returnPolicyService?: FakeReturnPolicyService,
): DropshipReturnService {
  return new DropshipReturnService({
    vendorProvisioning:
      new FakeVendorProvisioningService() as unknown as DropshipVendorProvisioningService,
    repository,
    notificationSender,
    returnPolicyService: returnPolicyService as never,
    clock: { now: () => now },
    logger: {
      info: (event) => logs.push(event),
      warn: (event) => logs.push(event),
      error: (event) => logs.push(event),
    },
  });
}

class FakeReturnPolicyService {
  fees: {
    restockingFee: {
      feeId: number;
      amountType: "flat_cents" | "percent";
      amount: number;
    } | null;
    processingFee: {
      feeId: number;
      amountType: "flat_cents" | "percent";
      amount: number;
    } | null;
    returnShippingFee: {
      feeId: number;
      amountType: "flat_cents" | "percent";
      amount: number;
    } | null;
  } = { restockingFee: null, processingFee: null, returnShippingFee: null };
  defaultFees = makeResolvedFees();
  feesByResponsibility = new Map<string, ReturnType<typeof makeResolvedFees>>();
  resolveCalls: Array<{ faultCategory: string }> = [];

  async resolveReturnFees(input?: { faultCategory: string }): Promise<never> {
    if (input) this.resolveCalls.push(input);
    return (
      input
        ? (this.feesByResponsibility.get(input.faultCategory) ?? this.fees)
        : this.fees
    ) as never;
  }

  async resolveDefaultReturnFees(): Promise<never> {
    return this.defaultFees as never;
  }
}

function makeFee(
  feeId: number,
  feeType: "restocking_fee" | "processing_fee" | "return_shipping_fee",
  faultCategory:
    "card_shellz" | "vendor" | "customer" | "marketplace" | "carrier",
  amountType: "flat_cents" | "percent",
  amount: number,
) {
  return {
    feeId,
    feeType,
    faultCategory,
    amountType,
    amount,
    isDefault: false,
  };
}

function makeResolvedFees(
  overrides: Partial<{
    restockingFee: ReturnType<typeof makeFee> | null;
    processingFee: ReturnType<typeof makeFee> | null;
    returnShippingFee: ReturnType<typeof makeFee> | null;
  }> = {},
) {
  return {
    restockingFee: null,
    processingFee: null,
    returnShippingFee: null,
    ...overrides,
  };
}

function configuredDecisionPolicyService(
  input: { restockingDefaultResponsibility?: "customer" | "vendor" } = {},
): FakeReturnPolicyService {
  const service = new FakeReturnPolicyService();
  const restockingDefaultResponsibility =
    input.restockingDefaultResponsibility ?? "customer";
  service.defaultFees = makeResolvedFees({
    restockingFee: makeFee(
      61,
      "restocking_fee",
      restockingDefaultResponsibility,
      "flat_cents",
      restockingDefaultResponsibility === "vendor" ? 300 : 250,
    ),
    processingFee: makeFee(62, "processing_fee", "card_shellz", "percent", 10),
    returnShippingFee: makeFee(
      63,
      "return_shipping_fee",
      "carrier",
      "flat_cents",
      0,
    ),
  });
  service.feesByResponsibility.set(
    "vendor",
    makeResolvedFees({
      restockingFee: makeFee(71, "restocking_fee", "vendor", "flat_cents", 300),
    }),
  );
  service.feesByResponsibility.set(
    "card_shellz",
    makeResolvedFees({
      processingFee: makeFee(
        72,
        "processing_fee",
        "card_shellz",
        "percent",
        10,
      ),
    }),
  );
  service.feesByResponsibility.set(
    "carrier",
    makeResolvedFees({
      returnShippingFee: makeFee(
        73,
        "return_shipping_fee",
        "carrier",
        "flat_cents",
        0,
      ),
    }),
  );
  return service;
}

function makeRma(
  overrides: Partial<DropshipRmaDetail> = {},
): DropshipRmaDetail {
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
    policyVersionId: 41,
    items: [],
    inspections: [],
    walletLedger: [],
    ...overrides,
  };
}

function makeRmaDetail(
  overrides: Partial<DropshipRmaDetail> = {},
): DropshipRmaDetail {
  return makeRma(overrides);
}

function makeOrderReference(
  overrides: Partial<DropshipRmaOrderReference> = {},
): DropshipRmaOrderReference {
  return {
    intakeId: 44,
    storeConnectionId: 70,
    status: "accepted",
    omsOrderId: 9001,
    acceptedAt: new Date("2026-05-01T19:00:00.000Z"),
    currency: "USD",
    lines: [
      {
        lineIndex: 0,
        externalLineItemId: "line-20",
        productVariantId: 20,
        sku: "SKU-20",
        title: "Order item 20",
        quantity: 2,
        unitRetailPriceCents: 1_500,
        lineRetailTotalCents: 3_000,
      },
      {
        lineIndex: 1,
        externalLineItemId: "line-21",
        productVariantId: 21,
        sku: "SKU-21",
        title: "Order item 21",
        quantity: 1,
        unitRetailPriceCents: 2_000,
        lineRetailTotalCents: 2_000,
      },
    ],
    ...overrides,
  };
}

function makeReturnPolicy(
  overrides: Partial<DropshipReturnPolicyRecord> = {},
): DropshipReturnPolicyRecord {
  return {
    policyId: 30,
    name: "Default returns",
    returnWindowDays: 30,
    isActive: true,
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now,
    ...overrides,
  };
}

function makeOrderEconomics(): DropshipRmaOrderEconomics {
  return {
    intakeId: 44,
    wholesaleSubtotalCents: 2_000,
    shippingCents: 800,
    currency: "USD",
    lines: [
      { productVariantId: 20, quantity: 2, wholesaleUnitCostCents: 1_000 },
    ],
  };
}

function makeVendor(
  overrides: Partial<DropshipProvisionedVendorProfile> = {},
): DropshipProvisionedVendorProfile {
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
