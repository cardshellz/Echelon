export const SHIPSTATION_TRACKING_API_BASE_URL = "https://api.shipengine.com/v1";

export function normalizeShipStationTrackingApiBaseUrl(
  explicitBaseUrl?: string,
): string {
  const rawBaseUrl = (explicitBaseUrl ?? SHIPSTATION_TRACKING_API_BASE_URL).trim();
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error("ShipStation tracking API base URL must be a valid absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("ShipStation tracking API base URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ShipStation tracking API base URL must not contain embedded credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("ShipStation tracking API base URL must not contain a query string or fragment");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function resolveShipStationTrackingApiKey(explicitApiKey?: string): string {
  return (
    explicitApiKey
    ?? process.env.SHIPSTATION_TRACKING_API_KEY
    ?? ""
  ).trim();
}
