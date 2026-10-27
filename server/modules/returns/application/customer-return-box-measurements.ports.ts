import type { CustomerReturnDimensions } from "@shared/returns/customer-return-parcel";

/** Exact original package evidence, never a suggested product/catalog box. */
export interface CustomerReturnBoxMeasurementKey {
  channelId: number;
  boxId: string;
  sourceFingerprint: string;
}
export interface CustomerReturnBoxMeasurements {
  read(key: CustomerReturnBoxMeasurementKey): Promise<CustomerReturnDimensions | null>;
}
