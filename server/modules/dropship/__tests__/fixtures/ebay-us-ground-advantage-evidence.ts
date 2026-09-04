/**
 * Sanitized fields from a read-only production GeteBayDetails response observed
 * 2026-09-04: site 0, compatibility level 1475, DetailName ShippingServiceDetails,
 * Ack Success. These are eBay identifiers, not display-name aliases.
 * Reference: https://developer.ebay.com/Devzone/XML/docs/Reference/eBay/GeteBayDetails.html
 */
export const EBAY_US_GROUND_ADVANTAGE_EVIDENCE = {
  Description: "USPS Ground Advantage",
  ShippingService: "USPSParcel",
  ShippingServiceID: 8,
  ShippingTimeMin: 2,
  ShippingTimeMax: 5,
  ValidForSellingFlow: true,
  DetailVersion: 1024,
  UpdateTime: "2026-07-20T19:26:46.000Z",
} as const;

export const EBAY_US_LEGACY_GROUND_EVIDENCE = {
  Description: "US Postal Service Ground",
  ShippingService: "USPSGround",
  ShippingServiceID: 17,
  ValidForSellingFlow: false,
} as const;
