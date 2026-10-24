import { z } from "zod";

/** Physical shipping form, independent of sales unit (each/box/case) and provider enums. */
export const shippingPackageTypeSchema = z.enum(["parcel", "letter", "large_envelope"]);
export type ShippingPackageType = z.infer<typeof shippingPackageTypeSchema>;
export const SHIPPING_PACKAGE_TYPES: ReadonlyArray<{ value: ShippingPackageType; label: string }> = [
  { value: "parcel", label: "Parcel / thick envelope" },
  { value: "letter", label: "Letter" },
  { value: "large_envelope", label: "Large envelope" },
];

export interface ChannelPackageFacts {
  weightGrams?: number | string | null;
  lengthMm?: number | string | null;
  widthMm?: number | string | null;
  heightMm?: number | string | null;
  shippingPackageType?: ShippingPackageType | null;
}

export interface ChannelPackageRequirements {
  weight: boolean;
  dimensions: boolean;
  packageType: boolean;
}
