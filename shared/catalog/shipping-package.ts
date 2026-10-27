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
  /** A provider may accept preservation of an already published package while
   * requiring dimensions on publication or a shipping-configuration change.
   * The adapter must prove that maintenance context before selecting this rule. */
  dimensionsOnMaintenance?: boolean | "recommended";
}

export type ChannelPackageOperation = "publication" | "maintenance";
