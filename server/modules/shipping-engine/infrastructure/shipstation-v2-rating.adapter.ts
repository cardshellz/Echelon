/**
 * ShipStation API v2 (ShipEngine dialect) rating adapter — calibration plane.
 *
 * Quotes the same wallet accounts labels are bought on (stamps_com,
 * ups_walleted, fedex) so quote ≈ actual label cost. Used OFFLINE to build
 * and spot-calibrate shipping.rate_tables — never called at checkout for
 * lower-48. Design: docs/SHIPPING-ENGINE-DESIGN.md ("Carrier Adapters").
 *
 * Graceful degradation: when SHIPSTATION_V2_API_KEY is absent every method
 * resolves a typed { configured: false } result — it NEVER throws for missing
 * config, so the calibration job can no-op on unconfigured environments.
 * HTTP/network failures throw structured ShipStationV2Error for the caller.
 *
 * The request-building/normalization functions are exported pure so unit
 * tests never touch the network.
 */

export const SHIPSTATION_V2_BASE_URL = "https://api.shipstation.com/v2";
const REQUEST_TIMEOUT_MS = 10_000;
/** 429 backoff mirrors server/modules/oms/shipstation.service.ts apiRequest. */
const DEFAULT_RETRY_AFTER_SECONDS = 2;
const MAX_RETRY_AFTER_SECONDS = 30;
const GRAMS_PER_OUNCE = 28.349523125;
const MM_PER_INCH = 25.4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface V2Address {
  name?: string;
  phone?: string;
  companyName?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode: string;
  countryCode: string;
}

export interface V2ParcelInput {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface V2RateRequest {
  /** ShipEngine carrier ids (e.g. "se-123456"); from listCarriers(). */
  carrierIds?: string[];
  from: V2Address;
  to: V2Address;
  parcels: V2ParcelInput[];
}

export interface V2NormalizedRate {
  /** Canonical display carrier (USPS/UPS/FedEx/DHL, else uppercased raw). */
  carrier: string;
  serviceCode: string;
  serviceName: string;
  /** Total of shipping + other + insurance + confirmation amounts. */
  amountCents: number;
  currency: string;
  deliveryDays: number | null;
  estimatedDeliveryDate: string | null;
}

export type V2RateResult =
  | { configured: false; rates: [] }
  | { configured: true; rates: V2NormalizedRate[] };

export interface V2Carrier {
  carrierId: string;
  code: string;
  name: string;
}

export type V2CarriersResult =
  | { configured: false; carriers: [] }
  | { configured: true; carriers: V2Carrier[] };

export class ShipStationV2Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ShipStationV2Error";
  }
}

// ---------------------------------------------------------------------------
// Pure unit conversions and mapping (exported for tests)
// ---------------------------------------------------------------------------

/** grams → ounces, 2dp; positive inputs never round to 0 (API rejects 0 oz). */
export function gramsToOunces(grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) return 0;
  const ounces = Math.round((grams / GRAMS_PER_OUNCE) * 100) / 100;
  return Math.max(ounces, 0.01);
}

/** mm → inches, 2dp. */
export function mmToInches(mm: number): number {
  if (!Number.isFinite(mm) || mm <= 0) return 0;
  return Math.round((mm / MM_PER_INCH) * 100) / 100;
}

/**
 * ShipEngine carrier_code → canonical display carrier. Mirrors C9's
 * normalizeCarrier families (server/modules/shipping/types.ts) with the
 * display casing used by the oms map (FedEx, not FEDEX).
 */
export function mapV2CarrierCode(carrierCode: string): string {
  const code = carrierCode.trim().toLowerCase();
  if (code === "stamps_com" || code === "usps") return "USPS";
  if (code === "ups" || code === "ups_walleted") return "UPS";
  if (code === "fedex") return "FedEx";
  if (code.startsWith("dhl")) return "DHL";
  return carrierCode.trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Pure request builder / response normalizers (exported for tests)
// ---------------------------------------------------------------------------

function toV2AddressBody(address: V2Address): Record<string, unknown> {
  const body: Record<string, unknown> = {
    postal_code: address.postalCode,
    country_code: address.countryCode,
  };
  if (address.name) body.name = address.name;
  if (address.phone) body.phone = address.phone;
  if (address.companyName) body.company_name = address.companyName;
  if (address.addressLine1) body.address_line1 = address.addressLine1;
  if (address.addressLine2) body.address_line2 = address.addressLine2;
  if (address.city) body.city_locality = address.city;
  if (address.state) body.state_province = address.state;
  return body;
}

/** POST /v2/rates body per the ShipEngine dialect. */
export function buildRatesRequestBody(request: V2RateRequest): Record<string, unknown> {
  return {
    rate_options: {
      carrier_ids: request.carrierIds ?? [],
    },
    shipment: {
      validate_address: "no_validation",
      ship_from: toV2AddressBody(request.from),
      ship_to: toV2AddressBody(request.to),
      packages: request.parcels.map((parcel) => {
        const length = mmToInches(parcel.lengthMm);
        const width = mmToInches(parcel.widthMm);
        const height = mmToInches(parcel.heightMm);
        const pkg: Record<string, unknown> = {
          weight: { value: gramsToOunces(parcel.weightGrams), unit: "ounce" },
        };
        // ShipEngine treats dimensions as optional; a 0 dimension is rejected,
        // so incomplete dims are omitted rather than sent as zeros.
        if (length > 0 && width > 0 && height > 0) {
          pkg.dimensions = { unit: "inch", length, width, height };
        }
        return pkg;
      }),
    },
  };
}

interface V2MoneyPayload {
  currency?: string;
  amount?: number;
}

function toCents(money: V2MoneyPayload | null | undefined): number {
  const amount = money?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

/** Normalize a /v2/rates response payload. Malformed entries are skipped. */
export function normalizeRatesResponse(payload: unknown): V2NormalizedRate[] {
  const rates = (payload as { rate_response?: { rates?: unknown[] } } | null)?.rate_response?.rates;
  if (!Array.isArray(rates)) return [];

  const normalized: V2NormalizedRate[] = [];
  for (const entry of rates) {
    const rate = entry as {
      carrier_code?: string;
      service_code?: string;
      service_type?: string;
      shipping_amount?: V2MoneyPayload;
      other_amount?: V2MoneyPayload;
      insurance_amount?: V2MoneyPayload;
      confirmation_amount?: V2MoneyPayload;
      delivery_days?: number;
      estimated_delivery_date?: string;
    } | null;
    if (!rate || typeof rate.service_code !== "string" || rate.shipping_amount == null) continue;

    normalized.push({
      carrier: mapV2CarrierCode(rate.carrier_code ?? ""),
      serviceCode: rate.service_code,
      serviceName: rate.service_type ?? rate.service_code,
      amountCents:
        toCents(rate.shipping_amount)
        + toCents(rate.other_amount)
        + toCents(rate.insurance_amount)
        + toCents(rate.confirmation_amount),
      currency: (rate.shipping_amount.currency ?? "usd").toUpperCase(),
      deliveryDays: typeof rate.delivery_days === "number" ? rate.delivery_days : null,
      estimatedDeliveryDate: typeof rate.estimated_delivery_date === "string"
        ? rate.estimated_delivery_date
        : null,
    });
  }
  return normalized;
}

/** Normalize a GET /v2/carriers response payload. */
export function normalizeCarriersResponse(payload: unknown): V2Carrier[] {
  const carriers = (payload as { carriers?: unknown[] } | null)?.carriers;
  if (!Array.isArray(carriers)) return [];

  const normalized: V2Carrier[] = [];
  for (const entry of carriers) {
    const carrier = entry as {
      carrier_id?: string;
      carrier_code?: string;
      friendly_name?: string;
    } | null;
    if (!carrier || typeof carrier.carrier_id !== "string" || typeof carrier.carrier_code !== "string") continue;
    normalized.push({
      carrierId: carrier.carrier_id,
      code: carrier.carrier_code,
      name: carrier.friendly_name ?? carrier.carrier_code,
    });
  }
  return normalized;
}

/** Retry-After header (seconds) → bounded wait. Exported for tests. */
export function parseRetryAfterSeconds(headerValue: string | null): number {
  const parsed = Number.parseInt(headerValue ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(parsed, MAX_RETRY_AFTER_SECONDS);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ShipStationV2RatingAdapter {
  isConfigured(): boolean;
  getRates(request: V2RateRequest): Promise<V2RateResult>;
  /** Calibration's first call, and the cheapest key-validation probe. */
  listCarriers(): Promise<V2CarriersResult>;
}

export interface ShipStationV2AdapterConfig {
  /** Defaults to process.env.SHIPSTATION_V2_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
}

export function createShipStationV2RatingAdapter(
  config: ShipStationV2AdapterConfig = {},
): ShipStationV2RatingAdapter {
  const apiKey = (config.apiKey ?? process.env.SHIPSTATION_V2_API_KEY ?? "").trim();
  const baseUrl = config.baseUrl ?? SHIPSTATION_V2_BASE_URL;

  function isConfigured(): boolean {
    return apiKey.length > 0;
  }

  async function apiRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path}`;
    const maxAttempts = 2; // single retry, on 429 only

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            "API-Key": apiKey,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new ShipStationV2Error(
          aborted ? "SHIPSTATION_V2_TIMEOUT" : "SHIPSTATION_V2_NETWORK_ERROR",
          aborted
            ? `ShipStation v2 ${method} ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`
            : `ShipStation v2 ${method} ${path} network failure: ${error instanceof Error ? error.message : String(error)}`,
          { method, path },
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 429 && attempt < maxAttempts) {
        const waitSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
        console.warn(
          `[ShipStationV2] 429 on ${method} ${path}; waiting ${waitSeconds}s before the single retry`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new ShipStationV2Error(
          "SHIPSTATION_V2_HTTP_ERROR",
          `ShipStation v2 ${method} ${path} failed (${response.status})`,
          { method, path, status: response.status, body: errorBody.slice(0, 500) },
        );
      }

      return (await response.json()) as T;
    }

    // Unreachable: the loop either returns or throws.
    throw new ShipStationV2Error("SHIPSTATION_V2_RETRIES_EXHAUSTED", `ShipStation v2 ${method} ${path} exhausted retries`, { method, path });
  }

  async function getRates(request: V2RateRequest): Promise<V2RateResult> {
    if (!isConfigured()) return { configured: false, rates: [] };
    if (request.parcels.length === 0) {
      // ShipEngine rejects zero-package shipments; nothing to rate.
      return { configured: true, rates: [] };
    }
    const payload = await apiRequest<unknown>("POST", "/rates", buildRatesRequestBody(request));
    return { configured: true, rates: normalizeRatesResponse(payload) };
  }

  async function listCarriers(): Promise<V2CarriersResult> {
    if (!isConfigured()) return { configured: false, carriers: [] };
    const payload = await apiRequest<unknown>("GET", "/carriers");
    return { configured: true, carriers: normalizeCarriersResponse(payload) };
  }

  return { isConfigured, getRates, listCarriers };
}
