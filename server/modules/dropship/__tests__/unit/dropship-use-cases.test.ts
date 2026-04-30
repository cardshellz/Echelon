import { describe, expect, it } from "vitest";
import { DropshipError, DropshipUseCaseNotImplementedError } from "../../domain/errors";
import type { DropshipApplicationPorts } from "../../application";
import {
  DROPSHIP_REQUIRED_USE_CASE_NAMES,
  createDropshipUseCaseRegistry,
  dropshipUseCaseDescriptors,
  validateDropshipUseCaseInput,
} from "../../application";

const fakePorts = {} as DropshipApplicationPorts;

function expectDropshipError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(DropshipError);
  expect((error as DropshipError).code).toBe(code);
}

describe("Dropship V2 use-case registry", () => {
  it("exposes every required consolidated-design use case", () => {
    const registry = createDropshipUseCaseRegistry(fakePorts);

    expect(Object.keys(registry).sort()).toEqual(
      [...DROPSHIP_REQUIRED_USE_CASE_NAMES].sort(),
    );
    expect(Object.keys(dropshipUseCaseDescriptors).sort()).toEqual(
      [...DROPSHIP_REQUIRED_USE_CASE_NAMES].sort(),
    );
  });

  it("requires transaction, idempotency, and audit policies for mutating use cases", () => {
    for (const name of DROPSHIP_REQUIRED_USE_CASE_NAMES) {
      const descriptor = dropshipUseCaseDescriptors[name];
      if (name === "GenerateVendorListingPreview") {
        expect(descriptor.transactionPolicy).toBe("read_only");
        expect(descriptor.idempotencyPolicy).toBe("not_required");
        expect(descriptor.auditPolicy).toBe("not_required");
        continue;
      }

      expect(descriptor.transactionPolicy).toBe("required");
      expect(descriptor.idempotencyPolicy).toBe("required");
      expect(descriptor.auditPolicy).toBe("required");
    }
  });

  it("documents external API mocks required by effectful use cases", () => {
    expect(dropshipUseCaseDescriptors.ProcessListingPushJob.externalApiMocksRequired).toEqual([
      "ebay",
      "shopify",
    ]);
    expect(dropshipUseCaseDescriptors.CreditWalletFunding.externalApiMocksRequired).toEqual([
      "stripe",
      "usdc_base",
    ]);
    expect(dropshipUseCaseDescriptors.QuoteDropshipShipping.externalApiMocksRequired).toEqual([
      "carrier",
    ]);
    expect(dropshipUseCaseDescriptors.SendDropshipNotification.externalApiMocksRequired).toEqual([
      "email",
    ]);
  });
});

describe("Dropship V2 use-case DTO validation", () => {
  it("rejects raw ATP leakage on listing preview input", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.GenerateVendorListingPreview,
        {
          vendorId: 1,
          storeConnectionId: 2,
          productVariantIds: [3],
          actor: { actorType: "vendor", actorId: "member-1" },
          rawAtpUnits: 500,
        },
      ),
    ).toThrow(DropshipError);
  });

  it("rejects fractional money and missing idempotency on wallet funding", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.CreditWalletFunding,
        {
          vendorId: 1,
          walletAccountId: 2,
          amountCents: 10.5,
          referenceType: "stripe_payment_intent",
          referenceId: "pi_123",
          idempotencyKey: "funding-123",
        },
      ),
    ).toThrow(DropshipError);

    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.CreditWalletFunding,
        {
          vendorId: 1,
          walletAccountId: 2,
          amountCents: 1050,
          referenceType: "stripe_payment_intent",
          referenceId: "pi_123",
        },
      ),
    ).toThrow(DropshipError);
  });

  it("requires explicit timestamps for tracking pushes", () => {
    expect(() =>
      validateDropshipUseCaseInput(
        dropshipUseCaseDescriptors.PushTrackingToVendorStore,
        {
          vendorId: 1,
          storeConnectionId: 2,
          intakeId: 3,
          carrier: "usps",
          trackingNumber: "9400",
          shippedAt: "2026-04-29T00:00:00.000Z",
          idempotencyKey: "tracking-123",
        },
      ),
    ).toThrow(DropshipError);
  });

  it("validates marketplace intake idempotency coordinates", () => {
    const parsed = validateDropshipUseCaseInput(
      dropshipUseCaseDescriptors.RecordMarketplaceOrderIntake,
      {
        vendorId: 1,
        storeConnectionId: 2,
        platform: "ebay",
        externalOrderId: "ORDER-1",
        rawPayload: { orderId: "ORDER-1" },
        payloadHash: "0123456789abcdef",
        idempotencyKey: "intake-ORDER-1",
      },
    );

    expect(parsed.storeConnectionId).toBe(2);
    expect(parsed.externalOrderId).toBe("ORDER-1");
  });
});

describe("Dropship V2 pending use-case execution", () => {
  it("fails closed after validation until an implementation is wired", async () => {
    const registry = createDropshipUseCaseRegistry(fakePorts);

    await expect(
      registry.GenerateVendorListingPreview.execute({
        vendorId: 1,
        storeConnectionId: 2,
        productVariantIds: [3],
        actor: { actorType: "vendor", actorId: "member-1" },
      }),
    ).rejects.toBeInstanceOf(DropshipUseCaseNotImplementedError);
  });

  it("throws structured validation errors before implementation errors", async () => {
    const registry = createDropshipUseCaseRegistry(fakePorts);
    let thrown: unknown;

    try {
      await registry.DebitWalletForOrder.execute({
        vendorId: 1,
        walletAccountId: 2,
        intakeId: 3,
        amountCents: 0,
        idempotencyKey: "debit-123",
      });
    } catch (error) {
      thrown = error;
    }

    expectDropshipError(thrown, "DROPSHIP_INVALID_USE_CASE_INPUT");
    expect((thrown as DropshipError).context).toMatchObject({
      useCaseName: "DebitWalletForOrder",
    });
  });
});
