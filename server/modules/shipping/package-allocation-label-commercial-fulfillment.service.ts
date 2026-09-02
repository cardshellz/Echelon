import type {
  MaterializeAndActivatePackageAllocationCommercialFulfillmentResult,
  ChannelFulfillmentAuthorityService,
} from "../oms/channel-fulfillment-authority.service";
import { FulfillmentAuthorityError } from "../oms/channel-fulfillment-authority.repository";
import type { StoredShippingProviderLabelObservation } from "./carrier-tracking.repository";
import type { ShippingProviderLabelLinkResult } from "./carrier-tracking.repository";
import {
  PackageAllocationBootstrapPersistenceError,
  type PackageAllocationBootstrapPersistenceResultV1,
  type PackageAllocationBootstrapPersistenceService,
} from "./package-allocation-bootstrap.service";
import {
  PackageAllocationLedgerRepositoryError,
} from "./package-allocation-ledger.repository";
import { PackageAllocationPersistenceError } from "./package-allocation-planning.service";
import type {
  PackageAllocationLabelCommercialReviewRepository,
} from "./package-allocation-label-commercial-review.repository";
import { parseExactPositiveWmsShipmentItems } from "./shipstation-provider-contents.domain";

const ACTIVATION_ACTOR = "system:shipstation_label_commercial_fulfillment";
const ACTIVATION_REASON =
  "Mark exact package contents shipped on the sales channel when an outbound label is observed";

export interface ShipStationLabelCommercialFulfillmentShipment {
  readonly shipmentId: number;
  readonly orderId?: number | null;
  readonly orderKey?: string | null;
  readonly orderNumber?: string | null;
  readonly trackingNumber?: string | null;
  readonly isReturnLabel?: boolean;
  readonly voidDate?: string | null;
  readonly shipmentItems?: unknown;
}

export interface PackageAllocationLabelCommercialFulfillmentLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
}

export interface PackageAllocationLabelLinker {
  reconcileShipStationLabel(providerLabelId: string): Promise<ShippingProviderLabelLinkResult>;
}

export type PackageAllocationLabelCommercialFulfillmentResult =
  | Readonly<{ outcome: "disabled" | "skipped"; reason: string }>
  | Readonly<{ outcome: "review"; reason: string }>
  | Readonly<{
      outcome: "activated";
      planId: string;
      commandIds: readonly number[];
      replayed: boolean;
    }>;

interface ReviewableError {
  readonly reasonCode: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const REVIEWABLE_LEDGER_CODES = new Set([
  "PACKAGE_EVIDENCE_NOT_FOUND",
  "SOURCE_EVIDENCE_NOT_FOUND",
]);

const REVIEWABLE_FULFILLMENT_CODES = new Set([
  "CANONICAL_STATE_CONFLICT",
  "CHANNEL_LINE_IDENTITY_MISSING",
  "CHANNEL_WRITEBACK_NOT_AUTHORIZED",
  "COMMAND_REQUEST_CONFLICT",
  "DUPLICATE_WMS_LINEAGE",
  "FULFILLMENT_AUTHORITY_EXCEEDED",
  "LEGACY_SHIPMENT_NOT_FOUND",
  "LEGACY_SHIPMENT_NOT_SHIPPED",
  "OMS_LINEAGE_MISSING",
  "PACKAGE_ALLOCATION_ACTIVATION_CONFLICT",
  "PACKAGE_ALLOCATION_EFFECT_CONFLICT",
  "PACKAGE_ALLOCATION_PLAN_NOT_FOUND",
  "PACKAGE_ALLOCATION_PLAN_STALE",
  "PACKAGE_IDENTITY_CONFLICT",
  "PHYSICAL_SHIPMENT_NOT_FOUND",
  "PROVIDER_ORDER_IDENTITY_MISSING",
]);

const REVIEWABLE_PERSISTENCE_CODES = new Set([
  "CURRENT_PLAN_MISSING",
  "INTENT_PAYLOAD_CONFLICT",
  "PERSISTED_STATE_INVALID",
  "REPLAY_CONFLICT",
  "SOURCE_EVIDENCE_CONFLICT",
  "STALE_GROUP_VERSION",
]);

function defaultLogger(): PackageAllocationLabelCommercialFulfillmentLogger {
  return {
    info: (event) => console.log(JSON.stringify(event)),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function reviewableError(error: unknown): ReviewableError | null {
  if (
    error instanceof PackageAllocationBootstrapPersistenceError
    && error.code === "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY"
  ) {
    return { reasonCode: error.code, details: error.context };
  }
  if (
    error instanceof PackageAllocationLedgerRepositoryError
    && REVIEWABLE_LEDGER_CODES.has(error.code)
  ) {
    return { reasonCode: error.code, details: error.context };
  }
  if (
    error instanceof PackageAllocationPersistenceError
    && REVIEWABLE_PERSISTENCE_CODES.has(error.code)
  ) {
    return { reasonCode: error.code, details: error.context };
  }
  if (
    error instanceof FulfillmentAuthorityError
    && REVIEWABLE_FULFILLMENT_CODES.has(error.code)
  ) {
    return {
      reasonCode: error.code,
      details: error.context,
    };
  }
  return null;
}

function bootstrapReviewReason(
  result: PackageAllocationBootstrapPersistenceResultV1,
): string {
  if (result.reviewReason) return result.reviewReason;
  const codes = result.resolution?.reviews.map((review) => review.code) ?? [];
  return codes.length > 0 ? [...new Set(codes)].sort().join("+") : "authority_review_required";
}

export class PackageAllocationLabelCommercialFulfillmentService {
  private readonly logger: PackageAllocationLabelCommercialFulfillmentLogger;

  constructor(
    private readonly dependencies: {
      readonly enabled: boolean;
      readonly labelLinker: PackageAllocationLabelLinker;
      readonly bootstrap: Pick<PackageAllocationBootstrapPersistenceService, "persistDiscovered">;
      readonly fulfillmentAuthority: Pick<
        ChannelFulfillmentAuthorityService,
        "materializeAndActivatePackageAllocationCommercialFulfillment"
      >;
      readonly reviewRepository: PackageAllocationLabelCommercialReviewRepository;
      readonly logger?: PackageAllocationLabelCommercialFulfillmentLogger;
    },
  ) {
    this.logger = dependencies.logger ?? defaultLogger();
  }

  async process(
    shipment: ShipStationLabelCommercialFulfillmentShipment,
    labelObservation: StoredShippingProviderLabelObservation,
  ): Promise<PackageAllocationLabelCommercialFulfillmentResult> {
    const providerShipmentId = nullableText(shipment.shipmentId);
    if (!providerShipmentId || !Number.isSafeInteger(shipment.shipmentId) || shipment.shipmentId <= 0) {
      throw new Error("ShipStation label commercial fulfillment requires a positive shipmentId");
    }
    if (!this.dependencies.enabled) {
      this.logger.warn({
        code: "PACKAGE_ALLOCATION_LABEL_COMMERCIAL_FULFILLMENT_DISABLED",
        providerShipmentId,
        shippingProviderLabelId: labelObservation.shippingProviderLabelId,
      });
      return Object.freeze({ outcome: "disabled", reason: "activation_disabled" });
    }
    if (shipment.isReturnLabel === true) {
      return Object.freeze({ outcome: "skipped", reason: "return_label" });
    }
    if (nullableText(shipment.voidDate)) {
      return Object.freeze({ outcome: "skipped", reason: "voided_label" });
    }
    if (shipment.isReturnLabel !== false) {
      throw new Error("ShipStation label commercial fulfillment requires proven outbound direction");
    }

    const exactItems = parseExactPositiveWmsShipmentItems(shipment.shipmentItems);
    const sourceWmsShipmentItemIds = exactItems?.map((item) => item.sourceShipmentItemId) ?? [];
    if (!exactItems) {
      await this.recordReview(
        shipment,
        labelObservation,
        "provider_contents_not_authoritative",
        sourceWmsShipmentItemIds,
        {},
      );
      return Object.freeze({ outcome: "review", reason: "provider_contents_not_authoritative" });
    }

    try {
      const links = await this.dependencies.labelLinker.reconcileShipStationLabel(
        providerShipmentId,
      );
      const bootstrap = await this.dependencies.bootstrap.persistDiscovered({
        contractVersion: 1,
        authorityMode: "shadow_only",
        bootstrapMode: "relationship_discovery",
        sourceWmsShipmentItemIds,
        writeContext: {
          createdBy: ACTIVATION_ACTOR,
          reason: ACTIVATION_REASON,
        },
      });
      if (bootstrap.outcome === "review" || !bootstrap.persistence?.planId) {
        const reason = bootstrapReviewReason(bootstrap);
        await this.recordReview(shipment, labelObservation, reason, sourceWmsShipmentItemIds, {
          labelLinksInserted: links.linksInserted,
          totalLabelLinks: links.totalLinks,
          selectedShippingProviderLabelIds: bootstrap.selectedShippingProviderLabelIds,
          readiness: bootstrap.readiness,
          resolution: bootstrap.resolution,
        });
        return Object.freeze({ outcome: "review", reason });
      }

      const activated: MaterializeAndActivatePackageAllocationCommercialFulfillmentResult =
        await this.dependencies.fulfillmentAuthority
          .materializeAndActivatePackageAllocationCommercialFulfillment({
            packageAllocationPlanId: bootstrap.persistence.planId,
            source: "shipstation_label_observed",
            correlationId: `shipping-provider-label:${labelObservation.shippingProviderLabelId}`,
            causationId: `shipstation-shipment:${providerShipmentId}`,
            activatedBy: ACTIVATION_ACTOR,
            activationReason: ACTIVATION_REASON,
          });
      const commandIds = activated.activation.commandIds;
      this.logger.info({
        code: "PACKAGE_ALLOCATION_LABEL_COMMERCIAL_FULFILLMENT_ACTIVATED",
        providerShipmentId,
        shippingProviderLabelId: labelObservation.shippingProviderLabelId,
        packageAllocationPlanId: bootstrap.persistence.planId,
        commandIds,
        replayed: activated.activation.replayed,
      });
      return Object.freeze({
        outcome: "activated",
        planId: bootstrap.persistence.planId,
        commandIds,
        replayed: activated.activation.replayed,
      });
    } catch (error) {
      const review = reviewableError(error);
      if (!review) throw error;
      await this.recordReview(
        shipment,
        labelObservation,
        review.reasonCode,
        sourceWmsShipmentItemIds,
        review.details,
      );
      return Object.freeze({ outcome: "review", reason: review.reasonCode });
    }
  }

  private async recordReview(
    shipment: ShipStationLabelCommercialFulfillmentShipment,
    labelObservation: StoredShippingProviderLabelObservation,
    reasonCode: string,
    sourceWmsShipmentItemIds: readonly number[],
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.dependencies.reviewRepository.record({
      shippingProviderLabelId: labelObservation.shippingProviderLabelId,
      providerShipmentId: String(shipment.shipmentId),
      providerOrderId: nullableText(shipment.orderId),
      providerOrderKey: nullableText(shipment.orderKey),
      orderNumber: nullableText(shipment.orderNumber),
      trackingNumber: nullableText(shipment.trackingNumber),
      reasonCode,
      sourceWmsShipmentItemIds,
      details,
    });
    this.logger.warn({
      code: "PACKAGE_ALLOCATION_LABEL_COMMERCIAL_FULFILLMENT_REVIEW_REQUIRED",
      providerShipmentId: String(shipment.shipmentId),
      shippingProviderLabelId: labelObservation.shippingProviderLabelId,
      reasonCode,
    });
  }
}
