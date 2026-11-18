import type { PoolClient } from "pg";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import type { ActiveInventoryPublicationTargetSnapshot } from "../application/inventory-channel-exposure-runtime.service";
import { previewProductDefinitionPublicationInsideTransaction } from "./inventory-availability-runtime-publication.repository";

export type IsolatedPreview =
  | { publication: Awaited<ReturnType<typeof previewProductDefinitionPublicationInsideTransaction>> }
  | { errorCode: string };

/** Dry run with the publisher's own isolation. Isolation already skips unsafe
 * destinations; what still throws (for example two destinations claiming one
 * provider scope) stops the whole product and is reported, not hidden. */
export async function previewIsolated(client: PoolClient, productId: number, snapshot: SupplySnapshotDto,
  targets: readonly ActiveInventoryPublicationTargetSnapshot[]): Promise<IsolatedPreview> {
  try {
    return { publication: await previewProductDefinitionPublicationInsideTransaction(client, productId, snapshot, targets, "isolate") };
  } catch (error) {
    if (error instanceof InventoryAvailabilityRuntimePublicationError) return { errorCode: error.code };
    throw error;
  }
}
