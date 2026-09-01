import { DropshipError } from "../domain/errors";

export interface DropshipEbayManagedLocation {
  merchantLocationKey: string;
  name: string;
  originWarehouseId: number;
  action: "created" | "enabled" | "updated" | "unchanged";
}

export interface DropshipEbayManagedLocationProvider {
  ensureForStoreConnection(input: {
    vendorId: number;
    storeConnectionId: number;
    originWarehouseId: number;
  }): Promise<DropshipEbayManagedLocation>;
  ensureWithAccessToken(input: {
    accessToken: string;
    environment: "sandbox" | "production";
    storeConnectionId: number;
    originWarehouseId: number;
  }): Promise<DropshipEbayManagedLocation>;
}

/**
 * The key is deterministic inside each seller account, so retries and
 * reconnects converge on one Card Shellz-owned eBay warehouse location.
 */
export function managedMerchantLocationKeyForWarehouse(
  originWarehouseId: number,
): string {
  if (!Number.isSafeInteger(originWarehouseId) || originWarehouseId <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_INPUT",
      "The managed eBay inventory location requires a valid origin warehouse.",
      { originWarehouseId, retryable: false },
    );
  }
  return `cardshellz-dropship-wh-${originWarehouseId}`;
}
