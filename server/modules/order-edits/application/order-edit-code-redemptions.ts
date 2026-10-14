/**
 * Compatibility adapter for already-persisted coupon/reward receipt operations.
 * New Shopify coupon entry does not depend on this service or the points ledger.
 */
export interface OrderEditCodeRedemptions {
  available(): boolean;
  reserve(operationId: string): Promise<void>;
  finalize(operationId: string): Promise<void>;
  release(operationId: string): Promise<void>;
}
