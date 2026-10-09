import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  planInventoryChannelExposureProduct,
  type InventoryChannelExposureRuntimeContext,
  type InventoryChannelExposureRuntimeLogger,
} from "./inventory-channel-exposure-runtime.service";

interface QuantityReviewBlocker {
  readonly code: string;
  readonly message: string;
}

export interface InventoryPublicationQuantityReview {
  readonly evidenceHash: string;
  readonly targets: readonly {
    readonly publicationTargetId: number;
    readonly blockers: readonly QuantityReviewBlocker[];
    readonly rows: readonly {
      readonly productVariantId: number;
      readonly desiredQuantity: string;
      readonly blockers: readonly QuantityReviewBlocker[];
    }[];
  }[];
}

/** Quantity-only enrollment boundary. ATP and channel exposure own supply
 * composition and quantity decisions. Consumers receive final quantities and
 * readiness errors, never physical warehouse contributions to reinterpret.
 * The opaque evidence hash still fences Apply against changed stock or rules. */
export function reviewInventoryPublicationQuantities(
  context: InventoryChannelExposureRuntimeContext,
  productId: number,
  logger?: InventoryChannelExposureRuntimeLogger,
): InventoryPublicationQuantityReview {
  const plan = planInventoryChannelExposureProduct(context, productId, logger);
  // Capture time is observational; the stock fingerprint and full plan remain
  // part of review identity without exposing those internals to the consumer.
  const { snapshotCapturedAt: _capturedAt, ...evidence } = plan;
  return {
    evidenceHash: createHash("sha256").update(canonicalJson(evidence)).digest("hex"),
    targets: plan.targets.map(target => ({
      publicationTargetId: target.publicationTargetId,
      blockers: target.blockers.map(quantityReviewBlocker),
      rows: target.rows.map(row => ({
        productVariantId: row.productVariantId,
        desiredQuantity: row.publishedUnits,
        blockers: row.blockers.map(quantityReviewBlocker),
      })),
    })),
  };
}

function quantityReviewBlocker({ code, message }: QuantityReviewBlocker): QuantityReviewBlocker {
  return { code, message };
}
