import type { CanonicalClaimDispatchBeforeCommit } from "../application/inventory-availability-dispatch.port";
import { InventoryShipmentRuntimeError } from "../application/inventory-availability-runtime-shipment.service";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import type { OperationalShipmentBeforeCommit } from "../../inventory/application/operational-shipment-dispatch.port";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";

/** Durable desired quantities are committed with custody, never sent to a provider here. */
export const publishCanonicalDispatchInsideTransaction: CanonicalClaimDispatchBeforeCommit = async ({ client, receipt }) => {
  await publishShipmentProduct(client, receipt.plan.command.productVariantId, "canonical_claim_dispatch");
};

export const publishOperationalShipmentInsideTransaction: OperationalShipmentBeforeCommit = async ({ client, request }) => {
  await publishShipmentProduct(client, request.productVariantId, "canonical_operational_dispatch");
};

async function publishShipmentProduct(client: InventoryAvailabilityTransactionQueryClient, productVariantId: number, triggeredBy: string): Promise<void> {
  const variants = await client.query(
    "SELECT product_id FROM catalog.product_variants WHERE id = $1",
    [productVariantId],
  );
  const productId: unknown = variants.rows[0]?.product_id;
  if (variants.rows.length !== 1 || typeof productId !== "number" || !Number.isSafeInteger(productId) || productId <= 0) {
    throw new InventoryShipmentRuntimeError("CLAIM_DISPATCH_PUBLICATION_PRODUCT_INVALID",
      "Dispatch publication requires the exact catalog product identity.");
  }
  await createTransactionScopedInventoryPublicationService(client).publishProduct({
    productId, dryRun: false, triggeredBy,
  }, async () => {
    throw new InventoryShipmentRuntimeError("CLAIM_DISPATCH_PUBLICATION_AUTHORITY_INVALID",
      "Canonical dispatch cannot publish through legacy authority.");
  });
}
