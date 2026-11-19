/** Physical measurements owned by Catalog; channel-only settings stay in adapters. */
export interface ChannelPackageFacts {
  weightGrams?: number | string | null;
  lengthMm?: number | string | null;
  widthMm?: number | string | null;
  heightMm?: number | string | null;
}

export interface ChannelPackageRequirements {
  weight: boolean;
  dimensions: boolean | "recommended";
}
