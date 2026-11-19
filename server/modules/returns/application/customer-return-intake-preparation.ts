import { createHash } from "node:crypto";
import { customerReturnPackingLimits } from "@shared/returns/customer-return-shipping-guardrails";
import {
  customerReturnLabelSubmitInputSchema,
  type CustomerReturnLabelSettings,
  type CustomerReturnLabelSubmitInput,
} from "@shared/returns/customer-return-label.contract";
import { normalizeCustomerReturnOrderReference } from "../domain/customer-return-order-reference";
import { customerReturnPublicLineId } from "./customer-return-live-packaging";
import { customerReturnProviderGid as gid } from "./customer-return-live-identity";
import { validateCustomerReturnBoxPlan } from "./customer-return-box-plan";
import {
  assertCustomerReturnShippingReady,
  customerReturnOriginAddress,
  customerReturnContactAddress,
  customerReturnWarehouseAddressType,
} from "./customer-return-shipping-plan";
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
          ? {
              orderReference: normalizeCustomerReturnOrderReference(
                input.orderReference,
              ),
            }
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
  assertCustomerReturnShippingReady(settings);
  const { local, provider, order, eligibility, facts } = inspection;
  if (
    input.channelId !== local.shop.channelId ||
    (expectedOmsOrderId !== undefined &&
      local.order.omsOrderId !== expectedOmsOrderId) ||
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
  const origin = customerReturnContactAddress(
    customerReturnOriginAddress(provider.order.shippingAddress), settings,
  );
  const publicLines = new Map(
    local.lines.flatMap((line) =>
      line.externalLineItemId === null
        ? []
        : [
            [
              customerReturnPublicLineId(
                local.shop.channelId,
                provider.order.id,
                gid("LineItem", line.externalLineItemId),
              ),
              line,
            ] as const,
          ],
    ),
  );
  const lines = prepareCustomerReturnSelectedLines(
    input.selections,
    inspection,
  );
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
      addressType: customerReturnWarehouseAddressType(
        settings.warehouseAddressType,
      ),
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
    expectedClaims: [],
    parcels: plan.parcels.map((parcel) => ({
      parcelKey: String(parcel.number),
      dimensions: parcel.dimensions,
      weightGrams: parcel.weightGrams,
      originAddress: origin,
      destinationAddress: customerReturnContactAddress(settings.destinationAddress, settings),
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

/** Shared by lookup readiness, review, and the final transactional submission. */
export function prepareCustomerReturnSelectedLines(
  selections: CustomerReturnLabelSubmitInput["selections"],
  inspection: Pick<CustomerReturnIntakeInspection, "local" | "provider" | "eligibility" | "facts">,
): PreparedCustomerReturnIntake["lines"] {
  const { local, provider, eligibility, facts } = inspection;
  return selections.map(selection => {
    const localLine = local.lines.find(line => line.externalLineItemId !== null
      && customerReturnPublicLineId(local.shop.channelId, provider.order.id,
        gid("LineItem", line.externalLineItemId)) === selection.lineId);
    const nativeId = localLine?.externalLineItemId;
    const purchased = nativeId ? provider.lines.find(line => line.id === gid("LineItem", nativeId)) : undefined;
    const eligible = purchased ? eligibility.lines.find(line => line.lineId === purchased.id) : undefined;
    if (!localLine || !nativeId || !purchased || !eligible || eligible.eligibleQuantity < selection.quantity) {
      throw new CustomerReturnIntakeError("RETURN_INTAKE_SOURCE_CHANGED", "Available return quantities changed. Review your items again.");
    }
    const externalClaims = facts.order.lines.find(line => line.lineId === purchased.id)!.claims
      .filter(claim => !claim.claimId.startsWith("local-root:") && !claim.claimId.startsWith("legacy-return-item:") && !claim.claimId.startsWith("inventory-return:"))
      .reduce((total, claim) => total + claim.quantity, 0);
    return { omsOrderLineId: localLine.omsOrderLineId, externalLineItemId: nativeId,
      quantity: selection.quantity, reasonCode: selection.reasonCode, allocations: [{
        sourceKind: "shopify_purchase" as const, wmsOrderItemId: null, fulfillmentId: null, fulfillmentLineItemId: null,
        quantity: selection.quantity, originalQuantity: purchased.quantity,
        eligibleQuantity: purchased.quantity - externalClaims,
        deliveryEvidence: { method: "verified_shopify_purchase_v1", orderId: provider.order.id,
          purchasedLineId: purchased.id, purchasedQuantity: purchased.quantity, observedAt: provider.observedAt },
      }] };
  });
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
