import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import type { SupplySnapshotDto, ClaimSupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { deriveVerifiedOpeningPositions } from "@shared/types/inventory-opening-quantity-projection";
import { parseSupplySnapshot, parseClaimSupplySnapshot, sealSupplySnapshot, sealClaimSupplySnapshot } from "./inventory-availability-planner";

/** Pure preview of the same lot-derived quantities the cutover ledger will post. */
export function projectVerifiedOpeningPositions(positions: SupplySnapshotDto["inventoryPositions"], verification: OpeningVerification | null) {
  if (!verification || verification.contractVersion === "inventory_cutover_opening_v1") return positions.map(row => ({ ...row }));
  const levels = new Map(deriveVerifiedOpeningPositions(verification.levels, verification.lots).map(row => [row.id,row]));
  return positions.map(position => {
    const level = levels.get(position.inventoryLevelId);
    if (!level || level.productVariantId !== position.productVariantId || level.warehouseLocationId !== position.warehouseLocationId) {
      throw Object.assign(new Error("The verified opening does not cover this exact inventory position"), { code: "CUTOVER_OPENING_POSITION_CHANGED" });
    }
    return { ...position, variantQty: level.variantQty, reservedQty: level.reservedQty, pickedQty: level.pickedQty, packedQty: level.packedQty };
  });
}

export function projectVerifiedOpeningSupply(raw: SupplySnapshotDto, verification: OpeningVerification | null): SupplySnapshotDto {
  const { snapshotFingerprint: _fingerprint, ...content } = parseSupplySnapshot(raw);
  return sealSupplySnapshot({ ...content, inventoryPositions: projectVerifiedOpeningPositions(content.inventoryPositions, verification) });
}

export function projectVerifiedOpeningClaimSupply(raw: ClaimSupplySnapshotDto, verification: OpeningVerification | null): ClaimSupplySnapshotDto {
  const { snapshotFingerprint: _fingerprint, ...content } = parseClaimSupplySnapshot(raw);
  return sealClaimSupplySnapshot({ ...content, inventoryPositions: projectVerifiedOpeningPositions(content.inventoryPositions, verification) });
}
