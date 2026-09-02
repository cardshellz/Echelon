import { createHash } from "node:crypto";
import { carrierIdentity } from "@shared/utils/carrier-identity";

import type {
  ChannelFulfillmentCommand,
  ChannelFulfillmentCommandItem,
} from "./channel-fulfillment-command";

export interface ExistingChannelFulfillmentCommandSnapshot {
  readonly id: number;
  readonly commandKey: string;
  readonly requestHash: string | null;
  readonly pushStatus: string;
  readonly lastErrorCode: string | null;
  readonly trackingNumber: string | null;
  readonly carrier: string | null;
  readonly shippingProvider: string | null;
  readonly providerPhysicalShipmentId: string | null;
  readonly items: readonly ChannelFulfillmentCommandItem[];
}

export type ChannelCommandSetReconciliation =
  | {
      readonly kind: "compatible";
      readonly coveredItems: readonly ChannelFulfillmentCommandItem[];
      readonly missingItems: readonly ChannelFulfillmentCommandItem[];
      readonly requeueCommandIds: readonly number[];
    }
  | {
      readonly kind: "conflict";
      readonly reason: string;
      readonly evidence: Readonly<Record<string, unknown>>;
    };

function normalizedText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function itemEvidence(item: ChannelFulfillmentCommandItem): Record<string, unknown> {
  return {
    physicalShipmentItemId: item.physicalShipmentItemId,
    shipmentRequestItemId: item.shipmentRequestItemId,
    omsOrderLineId: item.omsOrderLineId,
    channelOrderLineId: item.channelOrderLineId,
    quantity: item.quantity,
  };
}

function sameItem(
  left: ChannelFulfillmentCommandItem,
  right: ChannelFulfillmentCommandItem,
): boolean {
  return left.physicalShipmentItemId === right.physicalShipmentItemId
    && left.shipmentRequestItemId === right.shipmentRequestItemId
    && left.omsOrderLineId === right.omsOrderLineId
    && left.channelOrderLineId === right.channelOrderLineId
    && left.quantity === right.quantity;
}

/**
 * Reconciles immutable command snapshots against the current canonical package.
 *
 * Existing command items are never edited. A strict subset remains valid and
 * the missing physical items may be emitted as a deterministic supplemental
 * command. Overlapping or changed item allocations fail closed.
 */
export function reconcileChannelFulfillmentCommandSet(input: {
  readonly existingCommands: readonly ExistingChannelFulfillmentCommandSnapshot[];
  readonly incomingCommand: ChannelFulfillmentCommand;
  readonly shippingProvider: string;
  readonly providerPhysicalShipmentId: string;
}): ChannelCommandSetReconciliation {
  const incomingByPhysicalItem = new Map(
    input.incomingCommand.items.map((item) => [item.physicalShipmentItemId, item]),
  );
  const coveredByPhysicalItem = new Map<number, ChannelFulfillmentCommandItem>();
  const requeueCommandIds: number[] = [];

  for (const existing of input.existingCommands) {
    const existingTracking = normalizedText(existing.trackingNumber);
    const incomingTracking = normalizedText(input.incomingCommand.trackingNumber);
    const existingProvider = normalizedText(existing.shippingProvider)?.toLowerCase() ?? null;
    const existingPhysicalId = normalizedText(existing.providerPhysicalShipmentId);
    if (
      existingTracking !== incomingTracking
      || carrierIdentity(existing.carrier) !== carrierIdentity(input.incomingCommand.carrier)
      || (existingProvider !== null && existingProvider !== input.shippingProvider)
      || (
        existingPhysicalId !== null
        && existingPhysicalId !== input.providerPhysicalShipmentId
      )
    ) {
      return {
        kind: "conflict",
        reason: "immutable_package_identity_changed",
        evidence: Object.freeze({
          commandId: existing.id,
          commandKey: existing.commandKey,
          existingTracking,
          incomingTracking,
          existingCarrier: existing.carrier,
          incomingCarrier: input.incomingCommand.carrier,
          existingProvider,
          incomingProvider: input.shippingProvider,
          existingPhysicalId,
          incomingPhysicalId: input.providerPhysicalShipmentId,
        }),
      };
    }
    if (existing.items.length === 0) {
      return {
        kind: "conflict",
        reason: "existing_command_has_no_items",
        evidence: Object.freeze({
          commandId: existing.id,
          commandKey: existing.commandKey,
        }),
      };
    }

    for (const existingItem of existing.items) {
      const incomingItem = incomingByPhysicalItem.get(existingItem.physicalShipmentItemId);
      if (!incomingItem || !sameItem(existingItem, incomingItem)) {
        return {
          kind: "conflict",
          reason: "existing_item_is_not_an_exact_subset",
          evidence: Object.freeze({
            commandId: existing.id,
            commandKey: existing.commandKey,
            existingItem: itemEvidence(existingItem),
            incomingItem: incomingItem ? itemEvidence(incomingItem) : null,
          }),
        };
      }
      const priorCoverage = coveredByPhysicalItem.get(existingItem.physicalShipmentItemId);
      if (priorCoverage) {
        return {
          kind: "conflict",
          reason: "physical_item_covered_by_multiple_commands",
          evidence: Object.freeze({
            physicalShipmentItemId: existingItem.physicalShipmentItemId,
            commandId: existing.id,
          }),
        };
      }
      coveredByPhysicalItem.set(existingItem.physicalShipmentItemId, existingItem);
    }

    if (
      existing.pushStatus === "review"
      && existing.lastErrorCode === "COMMAND_REQUEST_CONFLICT"
    ) {
      requeueCommandIds.push(existing.id);
    } else if (
      !["pending", "retry", "success", "ignored"].includes(existing.pushStatus)
    ) {
      return {
        kind: "conflict",
        reason: "existing_command_status_is_not_repairable",
        evidence: Object.freeze({
          commandId: existing.id,
          commandKey: existing.commandKey,
          pushStatus: existing.pushStatus,
          lastErrorCode: existing.lastErrorCode,
        }),
      };
    }
  }

  return {
    kind: "compatible",
    coveredItems: Object.freeze([...coveredByPhysicalItem.values()]),
    missingItems: Object.freeze(
      input.incomingCommand.items.filter(
        (item) => !coveredByPhysicalItem.has(item.physicalShipmentItemId),
      ),
    ),
    requeueCommandIds: Object.freeze(requeueCommandIds.sort((left, right) => left - right)),
  };
}

export function buildSupplementalChannelFulfillmentScope(
  items: readonly ChannelFulfillmentCommandItem[],
): string {
  if (items.length === 0) {
    throw new Error("Supplemental channel fulfillment scope requires at least one item");
  }
  const identity = items
    .slice()
    .sort((left, right) =>
      left.physicalShipmentItemId - right.physicalShipmentItemId
      || left.omsOrderLineId - right.omsOrderLineId
      || left.channelOrderLineId.localeCompare(right.channelOrderLineId))
    .map((item) => [
      item.physicalShipmentItemId,
      item.shipmentRequestItemId,
      item.omsOrderLineId,
      item.channelOrderLineId,
      item.quantity,
    ]);
  const digest = createHash("sha256")
    .update(JSON.stringify(identity), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `order-remainder-v1-${digest}`;
}
