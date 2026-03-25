/**
 * Tracking URL Utility
 * 
 * Generates carrier-specific tracking URLs from carrier code and tracking number.
 * Centralized for reuse across OMS, WMS, and UI.
 */

const TRACKING_URL_TEMPLATES: Record<string, (trackingNumber: string) => string> = {
  usps: (num) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${num}`,
  ups: (num) => `https://www.ups.com/track?tracknum=${num}`,
  fedex: (num) => `https://www.fedex.com/fedextrack/?tracknumbers=${num}`,
  dhl: (num) => `https://www.dhl.com/en/express/tracking.html?AWB=${num}`,
};

/**
 * Generate a tracking URL for a given carrier and tracking number.
 * Returns null if carrier is unknown or tracking number is missing.
 */
export function buildTrackingUrl(carrier: string, trackingNumber: string): string | null {
  if (!carrier || !trackingNumber) return null;
  
  const template = TRACKING_URL_TEMPLATES[carrier.toLowerCase()];
  return template ? template(trackingNumber) : null;
}
