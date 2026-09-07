import type { InboundTrackingConfig, InboundTrackingSnapshot } from "@shared/procurement/inbound-tracking";
import { resolveShipStationTrackingApiKey } from "../shipping/shipstation-tracking-api-config";
import { createShipStationTrackingEventsClient, createShipStationTrackingHydrationRequest, ShipStationTrackingEventsError, isRetryableTrackingEventsError } from "../shipping/shipstation-tracking-events.client";
import { readBoundedResponseText } from "../shipping/shipstation-tracking-http";
import { InboundTrackingProviderError, parseSeaRatesTracking, parseShipStationInboundTracking } from "./inbound-tracking.domain";

export interface InboundTrackingProvider {
  configured(): boolean;
  fetch(config: InboundTrackingConfig): Promise<InboundTrackingSnapshot>;
}
export type InboundTrackingProviders = Record<"searates" | "shipstation", InboundTrackingProvider>;
const SEA_RATES_ENDPOINT = "https://tracking.searates.com/tracking";
const SEA_RATES_TYPES = { container: "CT", bill_of_lading: "BL", booking: "BK" } as const;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const SEA_RATES_RETRY_MESSAGES = new Set(["SEALINE_HASNT_PROVIDE_INFO", "NO_CONTAINERS", "NO_EVENTS", "SEALINE_NO_RESPONSE", "API_KEY_RATE_LIMIT", "UNEXPECTED_ERROR"]);
const SEA_RATES_REVIEW_MESSAGES = new Set(["WRONG_PARAMETERS", "WRONG_NUMBER", "WRONG_SEALINE", "WRONG_TYPE", "SEALINE_NOT_SUPPORTED", "SEALINE_NOT_SUPPORT_SHIPMENT_TYPE", "API_KEY_WRONG", "API_KEY_ACCESS_DENIED", "API_KEY_EXPIRED", "API_KEY_LIMIT_REACHED", "SEALINE_CANCELED_SHIPMENT"]);

export function createInboundTrackingProviders(options: { seaRatesApiKey?: string; shipStationApiKey?: string; fetchImpl?: typeof fetch; now?: () => Date } = {}): InboundTrackingProviders {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const seaRatesApiKey = (options.seaRatesApiKey ?? process.env.SEARATES_TRACKING_API_KEY ?? "").trim();
  const shipStationApiKey = resolveShipStationTrackingApiKey(options.shipStationApiKey);
  // Credential-bearing requests cannot follow redirects or accept a caller-controlled destination.
  const parcelFetch: typeof fetch = (url, init) => {
    const target = new URL(String(url));
    if (target.origin !== "https://api.shipstation.com" || target.pathname !== "/v2/tracking") throw new InboundTrackingProviderError("INVALID_DESTINATION", "Unsupported parcel tracking destination.", false);
    return fetchImpl(url, { ...init, redirect: "error" });
  };
  const parcel = createShipStationTrackingEventsClient({ apiKey: shipStationApiKey, fetchImpl: parcelFetch, nowMs: () => now().getTime() });
  return {
    shipstation: {
      configured: () => shipStationApiKey.length > 0,
      async fetch(config) {
        if (config.identity.provider !== "shipstation") throw new InboundTrackingProviderError("INVALID_PROVIDER", "Parcel provider identity does not match.", false);
        try {
          const result = await parcel.getTrackingSnapshot(createShipStationTrackingHydrationRequest({ carrierCode: config.identity.carrierCode, trackingNumber: config.identity.reference }));
          return parseShipStationInboundTracking(result.payload, config.identity);
        } catch (error) {
          if (error instanceof InboundTrackingProviderError) throw error;
          // Existing client errors can contain provider response bodies; never persist or log them in procurement.
          if (error instanceof ShipStationTrackingEventsError) throw new InboundTrackingProviderError(`SHIPSTATION_${error.code}`, error.code === "CONFIGURATION" ? "ShipStation tracking credentials are not configured." : `ShipStation tracking request failed (${error.code}). Check carrier access and provider availability.`, isRetryableTrackingEventsError(error));
          throw new InboundTrackingProviderError("SHIPSTATION_NETWORK", "ShipStation tracking request failed.", true);
        }
      },
    },
    searates: {
      configured: () => seaRatesApiKey.length > 0,
      async fetch(config) {
        if (config.identity.provider !== "searates" || config.identity.referenceType === "parcel") throw new InboundTrackingProviderError("INVALID_PROVIDER", "Ocean provider identity does not match.", false);
        if (!seaRatesApiKey) throw new InboundTrackingProviderError("CONFIGURATION", "SeaRates tracking credentials are not configured.", false);
        const url = new URL(SEA_RATES_ENDPOINT);
        // SeaRates requires query authentication. The URL and raw transport/provider errors must never reach logs, storage or the browser.
        url.search = new URLSearchParams({ api_key: seaRatesApiKey, number: config.identity.reference, type: SEA_RATES_TYPES[config.identity.referenceType], sealine: config.identity.carrierCode || "auto", force_update: "false", route: String(config.includeVesselPosition), ais: String(config.includeVesselPosition) }).toString();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Accept: "application/json" }, signal: controller.signal });
          if (!response.ok) {
            const rawRetryAfter = response.headers.get("retry-after");
            const retryAfter = rawRetryAfter && /^\d+$/.test(rawRetryAfter) ? Number(rawRetryAfter) * 1_000 : rawRetryAfter ? Math.max(0, Date.parse(rawRetryAfter) - now().getTime()) : null;
            await response.body?.cancel();
            throw new InboundTrackingProviderError(`SEARATES_HTTP_${response.status}`, `SeaRates returned HTTP ${response.status}. Check account access or provider availability.`, [408, 425, 429].includes(response.status) || response.status >= 500, retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null);
          }
          const raw: unknown = JSON.parse(await readBoundedResponseText(response, MAX_RESPONSE_BYTES));
          if (raw && typeof raw === "object" && "status" in raw && raw.status !== "success") {
            const message = "message" in raw && typeof raw.message === "string" ? raw.message : "UNKNOWN";
            const known = SEA_RATES_RETRY_MESSAGES.has(message) || SEA_RATES_REVIEW_MESSAGES.has(message);
            throw new InboundTrackingProviderError(known ? `SEARATES_${message}` : "SEARATES_REJECTED", known ? `SeaRates reported ${message.replaceAll("_", " ").toLowerCase()}.` : "SeaRates did not return a successful tracking response.", SEA_RATES_RETRY_MESSAGES.has(message));
          }
          return parseSeaRatesTracking(raw, config.identity);
        } catch (error) {
          if (error instanceof InboundTrackingProviderError) throw error;
          const timeout = controller.signal.aborted;
          if (error instanceof SyntaxError || (error instanceof Error && error.name === "ShipStationTrackingResponseReadError")) throw new InboundTrackingProviderError("INVALID_RESPONSE", "SeaRates returned invalid or oversized tracking data.", false);
          throw new InboundTrackingProviderError(timeout ? "SEARATES_TIMEOUT" : "SEARATES_NETWORK", timeout ? "SeaRates tracking request timed out." : "SeaRates tracking request failed.", true);
        } finally { controller.abort(); clearTimeout(timer); }
      },
    },
  };
}
