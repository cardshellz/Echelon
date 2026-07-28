export type ShipmentWeightSource =
  | "echelon_catalog"
  | "channel_fallback"
  | "missing";

export interface ShipmentLineInput {
  sku: string | null;
  productVariantId?: number | null;
  quantity: number;
  unitWeightGrams: number | null;
  unitPriceCents?: number | null;
  weightSource?: ShipmentWeightSource;
  shippingGroupCode?: string | null;
  shipsInOwnContainer?: boolean;
}

export interface ShippingParcelDimensions {
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface ShippingParcelSpec {
  sequence: number;
  source: "channel_weight" | "cartonization" | "prepacked";
  actualWeightGrams: number;
  billableWeightGrams: number;
  dimensions: ShippingParcelDimensions | null;
  shippingGroupCode: string | null;
}

export interface ShipmentParcelPlan {
  provider: {
    name: string;
    version: string;
  };
  strategy: string;
  /**
   * Optional customer-rate measure when source unit weights have known storage
   * precision. Parcel actual and billable weights remain unchanged for audit.
   */
  rateSelectionWeightGrams: number | null;
  parcels: ShippingParcelSpec[];
  warnings: string[];
}

export type ShipmentParcelPlanResult =
  | { ok: true; plan: ShipmentParcelPlan }
  | { ok: false; errors: string[] };
