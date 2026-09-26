import { createHash } from "node:crypto";
import {
  customerReturnLabelAddressSchema,
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSettings,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { normalizeCustomerReturnOrderReference } from "../domain/customer-return-order-reference";
import { projectCustomerReturnLiveWmsAllocations } from "./customer-return-live-delivery";
import { customerReturnPublicLineId } from "./customer-return-live-packaging";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";
import { validateCustomerReturnBoxPlan } from "./customer-return-box-plan";
import {
  CustomerReturnIntakeError,
  type PreparedCustomerReturnIntake,
} from "./customer-return-intake.ports";
import type { CustomerReturnIntakeInspection } from "./customer-return-live.service";

export function customerReturnSubmissionHash(
  input: CustomerReturnLabelSubmitInput,
): string {
  // Provider observations do not change the command's semantic intent. Box order
  // does: it determines the label-to-box numbers shown to the customer.
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId: input.channelId,
        orderReference: normalizeCustomerReturnOrderReference(
          input.orderReference,
        ),
        settingsVersion: input.settingsVersion,
        selections: [...input.selections].sort((a, b) =>
          compare(a.lineId, b.lineId),
        ),
        parcels: input.parcels.map((parcel) => ({
          ...parcel,
          items: [...parcel.items].sort((a, b) => compare(a.lineId, b.lineId)),
        })),
      }),
    )
    .digest("hex");
}

export function prepareCustomerReturnIntake(
  raw: CustomerReturnLabelSubmitInput,
  inspection: CustomerReturnIntakeInspection,
  settings: CustomerReturnLabelSettings,
  operationalPolicy: PreparedCustomerReturnIntake["operationalPolicy"],
  actor: string,
  submissionLeaseToken: string,
): PreparedCustomerReturnIntake {
  const input = customerReturnLabelSubmitInputSchema.parse(raw);
  const { local, provider, order, eligibility, facts } = inspection;
  if (
    input.channelId !== local.shop.channelId ||
    input.sourceRevision !== order.sourceRevision ||
    normalizeCustomerReturnOrderReference(input.orderReference) !==
      order.orderReference ||
    input.settingsVersion !== settings.version ||
    !settings.enabled
  ) {
    throw new CustomerReturnIntakeError(
      "RETURN_LIVE_REVIEW_CHANGED",
      "This return changed. Reload the order and review it again.",
    );
  }
  const plan = validateCustomerReturnBoxPlan(
    order.lines,
    { selections: input.selections, parcels: input.parcels },
    order.boxOptions,
  );
  const sourceAddress = provider.order.shippingAddress;
  const origin = customerReturnLabelAddressSchema.safeParse(
    sourceAddress && {
      name: sourceAddress.name,
      ...(sourceAddress.phone?.trim() ? { phone: sourceAddress.phone } : {}),
      ...(sourceAddress.company?.trim()
        ? { companyName: sourceAddress.company }
        : {}),
      addressLine1: sourceAddress.address1,
      ...(sourceAddress.address2?.trim()
        ? { addressLine2: sourceAddress.address2 }
        : {}),
      city: sourceAddress.city,
      state: sourceAddress.provinceCode,
      postalCode: sourceAddress.zip,
      countryCode: sourceAddress.countryCodeV2,
    },
  );
  if (!origin.success)
    throw new CustomerReturnIntakeError(
      "RETURN_LABEL_ORIGIN_UNVERIFIED",
      "The order's return shipping address needs verification before labels can be created.",
    );
  const mappings = projectCustomerReturnLiveWmsAllocations({
    local,
    shopify: provider,
  });
  const publicLines = new Map(
    local.lines.flatMap((line) =>
      line.externalLineItemId === null
        ? []
        : [
            [
              customerReturnPublicLineId(
                input.channelId,
                provider.order.id,
                gid("LineItem", line.externalLineItemId),
              ),
              line,
            ] as const,
          ],
    ),
  );
  const selectedIds = new Set<number>();
  const lines = input.selections.map((selection) => {
    const localLine = publicLines.get(selection.lineId);
    if (!localLine?.externalLineItemId) return mappingMissing();
    selectedIds.add(localLine.omsOrderLineId);
    const providerLineId = gid("LineItem", localLine.externalLineItemId);
    const eligible = eligibility.lines.find(
      (line) => line.lineId === providerLineId,
    );
    if (!eligible || eligible.eligibleQuantity < selection.quantity)
      return mappingMissing();
    const allocations: PreparedCustomerReturnIntake["lines"][number]["allocations"][number][] =
      [];
    let remaining = selection.quantity;
    for (const allocation of [...eligible.allocations].sort((a, b) =>
      compare(a.allocationId, b.allocationId),
    )) {
      if (remaining === 0) break;
      if (allocation.eligibleQuantity === 0) continue;
      const mapped = mappings.get(allocation.allocationId);
      if (!mapped?.length) return mappingMissing();
      const sourceFacts = facts.order.lines.find(
        (line) => line.lineId === providerLineId,
      )!;
      const externalClaims = sourceFacts.claims.filter(
        (claim) =>
          claim.allocationId === allocation.allocationId &&
          !claim.claimId.startsWith("local-root:"),
      );
      if (mapped.length > 1 && externalClaims.length > 0)
        return mappingMissing();
      let allocationRemaining = Math.min(
        remaining,
        allocation.eligibleQuantity,
      );
      for (const mapping of mapped) {
        const rootQuantity = local.rootClaims
          .filter(
            (claim) =>
              claim.wmsOrderItemId === mapping.wmsOrderItemId &&
              gid("FulfillmentLineItem", claim.fulfillmentLineItemId) ===
                allocation.fulfillmentLineItemId,
          )
          .reduce((total, claim) => total + claim.quantity, 0);
        const externalQuantity = externalClaims.reduce(
          (total, claim) => total + claim.quantity,
          0,
        );
        const available =
          mapping.originalQuantity - rootQuantity - externalQuantity;
        if (!Number.isSafeInteger(available) || available < 0)
          return mappingMissing();
        const quantity = Math.min(available, allocationRemaining);
        if (quantity > 0) {
          allocations.push({
            ...mapping,
            quantity,
            fulfillmentId: allocation.fulfillmentId,
            fulfillmentLineItemId: allocation.fulfillmentLineItemId,
            eligibleQuantity: allocation.deliveredQuantity,
            deliveryEvidence: {
              evidenceIds: allocation.evidenceIds,
              deliveryStatus: allocation.deliveryStatus,
            },
          });
          remaining -= quantity;
          allocationRemaining -= quantity;
        }
      }
    }
    if (remaining !== 0) return mappingMissing();
    return {
      omsOrderLineId: localLine.omsOrderLineId,
      externalLineItemId: localLine.externalLineItemId,
      quantity: selection.quantity,
      reasonCode: selection.reasonCode,
      allocations,
    };
  });
  return {
    channelId: input.channelId,
    omsOrderId: local.order.omsOrderId,
    idempotencyKey: input.idempotencyKey,
    submissionLeaseToken,
    semanticHash: customerReturnSubmissionHash(input),
    eligibilityRevision: order.sourceRevision,
    actor,
    observedAt: provider.observedAt,
    settingsVersion: settings.version,
    policySnapshot: {
      ...facts.policy,
      refundAuthority: "manual_shopify",
      windowBasis: "purchase",
    },
    warehouseSnapshot: {
      warehouseId: settings.warehouseId,
      version: settings.version,
      address: {
        name: settings.destinationAddress.name,
        address1: settings.destinationAddress.addressLine1,
        address2: settings.destinationAddress.addressLine2 ?? null,
        city: settings.destinationAddress.city,
        state: settings.destinationAddress.state,
        postalCode: settings.destinationAddress.postalCode,
        countryCode: "US",
      },
    },
    operationalPolicy,
    lines,
    expectedClaims: local.wmsItems
      .filter(
        (item) =>
          item.omsOrderLineId !== null && selectedIds.has(item.omsOrderLineId),
      )
      .map((item) => ({
        wmsOrderItemId: item.wmsOrderItemId,
        legacyExpectedQuantity: local.legacyClaims
          .filter((claim) => claim.wmsOrderItemId === item.wmsOrderItemId)
          .reduce((sum, claim) => sum + claim.expectedQuantity, 0),
        claimedQuantity: local.rootClaims
          .filter((claim) => claim.wmsOrderItemId === item.wmsOrderItemId)
          .reduce((sum, claim) => sum + claim.quantity, 0),
      })),
    parcels: plan.parcels.map((parcel) => ({
      parcelKey: String(parcel.number),
      dimensions: parcel.dimensions,
      weightGrams: parcel.weightGrams,
      originAddress: origin.data,
      destinationAddress: settings.destinationAddress,
      carrierId: settings.carrierId,
      serviceCode: settings.serviceCode,
      items: parcel.items.map((item) => ({
        omsOrderLineId: publicLines.get(item.lineId)!.omsOrderLineId,
        quantity: item.quantity,
      })),
    })),
  };
}

function mappingMissing(): never {
  throw new CustomerReturnIntakeError(
    "RETURN_LABEL_ALLOCATION_UNVERIFIED",
    "The original shipment and warehouse quantities need verification before this return can be created.",
  );
}
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
