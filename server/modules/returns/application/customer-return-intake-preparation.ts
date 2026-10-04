import { createHash } from "node:crypto";
import { customerReturnPackingLimits } from "@shared/returns/customer-return-shipping-guardrails";
import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSettings,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { normalizeCustomerReturnOrderReference } from "../domain/customer-return-order-reference";
import { projectCustomerReturnLiveWmsAllocations } from "./customer-return-live-delivery";
import { customerReturnPublicLineId } from "./customer-return-live-packaging";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";
import { validateCustomerReturnBoxPlan } from "./customer-return-box-plan";
import { customerReturnOriginAddress, customerReturnWarehouseAddressType } from "./customer-return-shipping-plan";
import {
  CustomerReturnIntakeError,
  type PreparedCustomerReturnIntake,
} from "./customer-return-intake.ports";
import type { CustomerReturnIntakeInspection } from "./customer-return-live.service";

export function customerReturnSubmissionHash(
  input: CustomerReturnLabelSubmitInput,
  omsOrderId?: number,
): string {
  // Provider observations do not change the command's semantic intent. Box order
  // does: it determines the label-to-box numbers shown to the customer.
  // Customer commands use the canonical order even if its display number changes.
  return createHash("sha256")
    .update(
      JSON.stringify({
        channelId: input.channelId,
        ...(omsOrderId === undefined
          ? { orderReference: normalizeCustomerReturnOrderReference(input.orderReference) }
          : { omsOrderId }),
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
  expectedOmsOrderId?: number,
): PreparedCustomerReturnIntake {
  const input = customerReturnLabelSubmitInputSchema.parse(raw);
  const { local, provider, order, eligibility, facts } = inspection;
  if (
    input.channelId !== local.shop.channelId ||
    (expectedOmsOrderId !== undefined && local.order.omsOrderId !== expectedOmsOrderId) ||
    input.sourceRevision !== order.sourceRevision ||
    normalizeCustomerReturnOrderReference(input.orderReference) !==
      order.orderReference ||
    input.settingsVersion !== settings.version ||
    settings.policyId !== operationalPolicy.id ||
    canonical(inspection.operationalPolicy) !== canonical(operationalPolicy) ||
    facts.policy.version !== operationalPolicy.version ||
    facts.policy.returnWindowDays !==
      operationalPolicy.snapshot.returnWindowDays ||
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
    customerReturnPackingLimits(settings),
  );
  const origin = customerReturnOriginAddress(provider.order.shippingAddress);
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
    semanticHash: customerReturnSubmissionHash(input, expectedOmsOrderId),
    eligibilityRevision: order.sourceRevision,
    actor,
    observedAt: provider.observedAt,
    returnWindowEndsAt: eligibility.returnWindowEndsAt,
    settingsVersion: settings.version,
    policySnapshot: {
      ...facts.policy,
      policyId: operationalPolicy.id,
      returnWindowEndsAt: eligibility.returnWindowEndsAt,
      operationalPolicy: { ...operationalPolicy.snapshot },
      refundAuthority: "manual_shopify",
      windowBasis: "purchase",
    },
    warehouseSnapshot: {
      warehouseId: settings.warehouseId,
      addressType: customerReturnWarehouseAddressType(settings.warehouseAddressType),
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
      originAddress: origin,
      destinationAddress: settings.destinationAddress,
      selectionMode: settings.selectionMode,
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
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => compare(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}
