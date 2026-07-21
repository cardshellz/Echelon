export const SHIPSTATION_TRACKING_API_BASE_URL = "https://api.shipstation.com/v2";
export const SHIPSTATION_TRACKING_WEBHOOK_SECRET_HEADER =
  "x-echelon-shipstation-tracking-secret";
export const SHIPSTATION_TRACKING_WEBHOOK_SECRET_KEY_ID =
  "echelon-shipstation-v2-track-v1";

const MINIMUM_WEBHOOK_SECRET_LENGTH = 32;
const MAXIMUM_WEBHOOK_SECRET_LENGTH = 512;

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
    ?? process.env.SHIPSTATION_V2_API_KEY
    ?? ""
  ).trim();
}

export function resolveShipStationTrackingWebhookSecret(
  explicitSecret?: string,
): string {
  return (
    explicitSecret
    ?? process.env.SHIPSTATION_TRACKING_WEBHOOK_SECRET
    ?? ""
  ).trim();
}

export function assertValidShipStationTrackingWebhookSecret(secret: string): void {
  if (secret.length < MINIMUM_WEBHOOK_SECRET_LENGTH
      || secret.length > MAXIMUM_WEBHOOK_SECRET_LENGTH
      || !/^[\x21-\x7E]+$/.test(secret)) {
    throw new Error(
      `SHIPSTATION_TRACKING_WEBHOOK_SECRET must contain ${MINIMUM_WEBHOOK_SECRET_LENGTH}`
      + ` through ${MAXIMUM_WEBHOOK_SECRET_LENGTH} printable non-whitespace ASCII characters`,
    );
  }
}
