import { z } from "zod";

// eBay US adapter policy: an unclassified physical shipment uses the ordinary
// parcel class. Existing provider classifications always take precedence.
// This is a transport classification, never a source of package measurements.
export const EBAY_US_STANDARD_PACKAGE_TYPE = "PACKAGE_THICK_ENVELOPE";

const text = z.string().min(1).max(100).refine(value => value.trim().length > 0);
const scope = { sku: text, marketplaceId: z.literal("EBAY_US") };
const packageType = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

// Preserve the shape of existing sealed native-preservation proofs. A default
// records the verified absence separately so it cannot impersonate an observed value.
export const ebayPreparedPackageTypeSchema = z.union([
  z.object({ ...scope, listingId: text, packageType }).strict(),
  z.object({ ...scope, listingId: text.nullable(), packageType: z.literal(EBAY_US_STANDARD_PACKAGE_TYPE),
    source: z.literal("marketplace_default"), observedPackageType: z.null() }).strict(),
]);
export type EbayPreparedPackageType = z.infer<typeof ebayPreparedPackageTypeSchema>;
