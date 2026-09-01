import { createHash } from "crypto";
import { DropshipError } from "../domain/errors";
import type {
  DropshipEbayFulfillmentPolicyOption,
  DropshipEbayListingSetupOption,
  DropshipEbayListingSetupResult,
  DropshipEbayListingSetupService,
} from "./dropship-ebay-listing-setup-service";
import {
  listDropshipEbayListingPolicyOverridesForMemberInputSchema,
  replaceDropshipEbayListingPolicyOverrideForMemberInputSchema,
} from "./dropship-ebay-listing-policy-override-dtos";
import type { DropshipClock, DropshipLogger } from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";

export interface DropshipEbayListingPolicyOverride {
  productVariantId: number;
  revisionId: number;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  updatedAt: Date;
}

export interface DropshipEbayListingPolicyOverrideContext {
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  status: string;
}

export interface ReplaceDropshipEbayListingPolicyOverrideRepositoryInput {
  vendorId: number;
  storeConnectionId: number;
  productVariantId: number;
  expectedRevisionId: number | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "vendor" | "admin" | "system";
    actorId: string | null;
  };
  now: Date;
}

export interface ReplaceDropshipEbayListingPolicyOverrideRepositoryResult {
  assignment: DropshipEbayListingPolicyOverride | null;
  revisionId: number;
  idempotentReplay: boolean;
}

export interface DropshipEbayListingPolicyOverrideRepository {
  loadStoreContext(input: {
    vendorId: number;
    storeConnectionId: number;
  }): Promise<DropshipEbayListingPolicyOverrideContext | null>;
  listAssignments(input: {
    vendorId: number;
    storeConnectionId: number;
    productVariantIds?: readonly number[];
  }): Promise<DropshipEbayListingPolicyOverride[]>;
  replaceAssignment(
    input: ReplaceDropshipEbayListingPolicyOverrideRepositoryInput,
  ): Promise<ReplaceDropshipEbayListingPolicyOverrideRepositoryResult>;
}

type ListingSetupPort = Pick<DropshipEbayListingSetupService, "getForMember">;

export interface DropshipEbayListingPolicyOverrideResult {
  storeConnectionId: number;
  defaults: {
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
  };
  options: {
    fulfillmentPolicies: DropshipEbayFulfillmentPolicyOption[];
    returnPolicies: DropshipEbayListingSetupOption[];
    paymentPolicies: DropshipEbayListingSetupOption[];
  };
  assignments: DropshipEbayListingPolicyOverride[];
  fetchedAt: Date;
}

export class DropshipEbayListingPolicyOverrideService {
  constructor(private readonly deps: {
    vendorProvisioning: DropshipVendorProvisioningService;
    repository: DropshipEbayListingPolicyOverrideRepository;
    listingSetup: ListingSetupPort;
    clock: DropshipClock;
    logger: DropshipLogger;
  }) {}

  async listForMember(memberId: string, input: unknown): Promise<DropshipEbayListingPolicyOverrideResult> {
    const parsed = listDropshipEbayListingPolicyOverridesForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    await this.requireConnectedEbayStore(vendor.vendorId, parsed.storeConnectionId);
    const [setup, assignments] = await Promise.all([
      this.deps.listingSetup.getForMember(memberId, parsed.storeConnectionId),
      this.deps.repository.listAssignments({
        vendorId: vendor.vendorId,
        storeConnectionId: parsed.storeConnectionId,
      }),
    ]);
    return buildResult(parsed.storeConnectionId, setup, assignments, this.deps.clock.now());
  }

  async replaceForMember(
    memberId: string,
    input: unknown,
  ): Promise<ReplaceDropshipEbayListingPolicyOverrideRepositoryResult> {
    const parsed = replaceDropshipEbayListingPolicyOverrideForMemberInputSchema.parse(input);
    const vendor = (await this.deps.vendorProvisioning.provisionForMember(memberId)).vendor;
    await this.requireConnectedEbayStore(vendor.vendorId, parsed.storeConnectionId);
    const setup = await this.deps.listingSetup.getForMember(memberId, parsed.storeConnectionId);
    validateSelection(parsed, setup);
    const requestHash = hashEbayListingPolicyOverride(parsed);
    const result = await this.deps.repository.replaceAssignment({
      vendorId: vendor.vendorId,
      storeConnectionId: parsed.storeConnectionId,
      productVariantId: parsed.productVariantId,
      expectedRevisionId: parsed.expectedRevisionId,
      fulfillmentPolicyId: parsed.fulfillmentPolicyId,
      returnPolicyId: parsed.returnPolicyId,
      paymentPolicyId: parsed.paymentPolicyId,
      idempotencyKey: parsed.idempotencyKey,
      requestHash,
      actor: { actorType: "vendor", actorId: memberId },
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_REPLAYED"
        : "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_REPLACED",
      message: result.idempotentReplay
        ? "eBay listing policy override replayed by idempotency key."
        : "eBay listing policy override replaced.",
      context: {
        vendorId: vendor.vendorId,
        storeConnectionId: parsed.storeConnectionId,
        productVariantId: parsed.productVariantId,
        revisionId: result.revisionId,
        inheritedPolicyCount: [
          parsed.fulfillmentPolicyId,
          parsed.returnPolicyId,
          parsed.paymentPolicyId,
        ].filter((value) => value === null).length,
      },
    });
    return result;
  }

  private async requireConnectedEbayStore(
    vendorId: number,
    storeConnectionId: number,
  ): Promise<DropshipEbayListingPolicyOverrideContext> {
    const context = await this.deps.repository.loadStoreContext({ vendorId, storeConnectionId });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_STORE_CONNECTION_REQUIRED",
        "Dropship store connection was not found.",
        { vendorId, storeConnectionId },
      );
    }
    if (context.platform !== "ebay") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_REQUIRED",
        "eBay listing policy overrides are available only for an eBay connection.",
        { vendorId, storeConnectionId, platform: context.platform },
      );
    }
    if (context.status !== "connected") {
      throw new DropshipError(
        "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
        "Reconnect the eBay store before changing listing policy overrides.",
        { vendorId, storeConnectionId, status: context.status },
      );
    }
    return context;
  }
}

function buildResult(
  storeConnectionId: number,
  setup: DropshipEbayListingSetupResult,
  assignments: DropshipEbayListingPolicyOverride[],
  fetchedAt: Date,
): DropshipEbayListingPolicyOverrideResult {
  return {
    storeConnectionId,
    defaults: {
      fulfillmentPolicyId: setup.selection.fulfillmentPolicyId,
      returnPolicyId: setup.selection.returnPolicyId,
      paymentPolicyId: setup.selection.paymentPolicyId,
    },
    options: {
      fulfillmentPolicies: setup.options.fulfillmentPolicies,
      returnPolicies: setup.options.returnPolicies,
      paymentPolicies: setup.options.paymentPolicies,
    },
    assignments,
    fetchedAt,
  };
}

function validateSelection(
  selection: {
    storeConnectionId: number;
    productVariantId: number;
    expectedRevisionId: number | null;
    fulfillmentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentPolicyId: string | null;
  },
  setup: DropshipEbayListingSetupResult,
): void {
  const invalidFields: string[] = [];
  if (selection.fulfillmentPolicyId !== null) {
    const option = setup.options.fulfillmentPolicies.find(
      (policy) => policy.id === selection.fulfillmentPolicyId,
    );
    if (!option || !option.compatible) invalidFields.push("fulfillmentPolicyId");
  }
  if (selection.returnPolicyId !== null
    && !setup.options.returnPolicies.some((policy) => policy.id === selection.returnPolicyId)) {
    invalidFields.push("returnPolicyId");
  }
  if (selection.paymentPolicyId !== null
    && !setup.options.paymentPolicies.some((policy) => policy.id === selection.paymentPolicyId)) {
    invalidFields.push("paymentPolicyId");
  }
  if (invalidFields.length > 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_INVALID",
      "Select current compatible policies from the connected eBay store.",
      {
        storeConnectionId: selection.storeConnectionId,
        productVariantId: selection.productVariantId,
        invalidFields,
      },
    );
  }
}

export function hashEbayListingPolicyOverride(input: {
  storeConnectionId: number;
  productVariantId: number;
  expectedRevisionId: number | null;
  fulfillmentPolicyId: string | null;
  returnPolicyId: string | null;
  paymentPolicyId: string | null;
}): string {
  return createHash("sha256").update(JSON.stringify({
    storeConnectionId: input.storeConnectionId,
    productVariantId: input.productVariantId,
    expectedRevisionId: input.expectedRevisionId,
    fulfillmentPolicyId: input.fulfillmentPolicyId,
    returnPolicyId: input.returnPolicyId,
    paymentPolicyId: input.paymentPolicyId,
  })).digest("hex");
}
