import Decimal from "decimal.js";
import { z } from "zod";
import {
  ReturnLabelProviderError,
  returnLabelInputSchema,
  returnLabelProviderIdSchema,
  returnLabelRecordSchema,
  type ReturnLabelAddress,
  type ReturnLabelInput,
  type ReturnLabelProvider,
  type ReturnLabelRecord,
} from "../application/return-label-provider.port";

const API_ORIGIN = "https://api.shipstation.com";
const API_PATH = "/v2";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 1_048_576;
const RECOVERY_PAGE_SIZE = 50;
const MAX_RECOVERY_LABELS = 100;
const Exact = Decimal.clone({ precision: 50 });
const nonempty = z.string().trim().min(1).max(2048);
const numeric = z.union([z.number().finite(), z.string().max(50).regex(/^\d+(?:\.\d+)?$/)]);
const moneySchema = z.object({ currency: z.string(), amount: numeric });
const weightSchema = z.object({ value: numeric, unit: z.enum(["gram", "kilogram", "ounce", "pound"]) });
const dimensionSchema = z.object({ unit: z.enum(["inch", "centimeter"]), length: numeric, width: numeric, height: numeric });
const packageSchema = z.object({
  package_code: z.literal("package"),
  weight: weightSchema,
  dimensions: dimensionSchema,
  tracking_number: nonempty.optional(),
});
const labelSchema = z.object({
  label_id: returnLabelProviderIdSchema,
  shipment_id: returnLabelProviderIdSchema,
  external_shipment_id: z.string().nullish(),
  status: z.enum(["processing", "completed", "error", "voided"]),
  is_return_label: z.boolean(),
  is_international: z.boolean(),
  rma_number: z.string().nullish(),
  carrier_id: returnLabelProviderIdSchema,
  service_code: nonempty,
  tracking_number: nonempty,
  trackable: z.boolean(),
  voided: z.boolean(),
  voided_at: z.string().nullish(),
  label_format: z.string(),
  label_layout: z.string(),
  charge_event: z.string(),
  created_at: z.string().datetime({ offset: true }),
  shipment_cost: moneySchema,
  insurance_cost: moneySchema,
  label_download: z.object({ pdf: z.string().min(1).max(2048).optional(), href: z.string().min(1).max(2048) }),
  packages: z.array(packageSchema).length(1),
});
const addressSchema = z.object({
  name: z.string(), phone: z.string().nullish(), company_name: z.string().nullish(),
  address_line1: z.string(), address_line2: z.string().nullish(), address_line3: z.string().nullish(),
  city_locality: z.string(), state_province: z.string(), postal_code: z.string(), country_code: z.string(),
});
const shipmentSchema = z.object({
  shipment_id: returnLabelProviderIdSchema,
  external_shipment_id: z.string(),
  carrier_id: returnLabelProviderIdSchema,
  service_code: nonempty,
  ship_from: addressSchema,
  ship_to: addressSchema,
  packages: z.array(packageSchema).length(1),
});
const listSchema = z.object({
  labels: z.array(z.object({ label_id: returnLabelProviderIdSchema, external_shipment_id: z.string().nullish() })).max(RECOVERY_PAGE_SIZE),
  page: z.number().int().positive().safe(),
  pages: z.number().int().nonnegative().safe(),
  total: z.number().int().nonnegative().safe(),
});

export interface ShipStationReturnLabelAdapterConfig {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Dedicated effect adapter. No global credentials, database imports or automatic POST retries.
 * https://docs.shipstation.com/return-labels restricts is_return_label to POST /v2/labels.
 */
export function createShipStationReturnLabelAdapter(config: ShipStationReturnLabelAdapterConfig): ReturnLabelProvider {
  const credential = z.string().trim().min(1).max(4096).regex(/^[^\s\u0000-\u001f\u007f]+$/).safeParse(config.apiKey);
  const timeout = z.number().int().min(1).max(30_000).safeParse(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!credential.success || !timeout.success) fail("RETURN_LABEL_CONFIGURATION_INVALID", "rejected");
  const apiKey = credential.data;
  const timeoutMs = timeout.data;
  const fetchFn = config.fetchFn ?? fetch;

  async function request(method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) fail("RETURN_LABEL_INPUT_TOO_LARGE", "rejected");
    if (signal?.aborted) fail("RETURN_LABEL_CANCELLED", method === "POST" ? "rejected" : "unknown", true);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const deadline = new Promise<never>((_, reject) => {
      const abort = (code: string) => {
        controller.abort();
        reject(new ReturnLabelProviderError(code, "unknown", true));
      };
      cancel = () => abort("RETURN_LABEL_CANCELLED");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => abort("RETURN_LABEL_TIMEOUT"), timeoutMs);
    });
    const work = async (): Promise<unknown> => {
      if (controller.signal.aborted) fail("RETURN_LABEL_CANCELLED", "unknown", true);
      let response: Response;
      try {
        response = await fetchFn(`${API_ORIGIN}${API_PATH}${path}`, {
          method, headers: { "API-Key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
          body: serialized, signal: controller.signal, redirect: "error", cache: "no-store",
        });
      } catch { fail("RETURN_LABEL_TRANSPORT_FAILED", "unknown", true); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        // A single-label validation/authentication rejection is definitive. Conflicts,
        // server failures and every ambiguous transport outcome require reconciliation.
        const rejected = method === "POST" && [400, 401, 403, 404, 405, 422, 429].includes(response.status);
        fail(response.status === 401 || response.status === 403 ? "RETURN_LABEL_CREDENTIAL_REJECTED" : "RETURN_LABEL_HTTP_ERROR",
          rejected ? "rejected" : "unknown", response.status === 429 || response.status >= 500);
      }
      return readJson(response);
    };
    try { return await Promise.race([work(), deadline]); }
    catch (error) {
      if (error instanceof ReturnLabelProviderError) throw error;
      fail("RETURN_LABEL_RESPONSE_INVALID", "unknown");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      controller.abort();
    }
  }

  async function verify(raw: unknown, input: ReturnLabelInput, signal?: AbortSignal, expectedLabelId?: string): Promise<ReturnLabelRecord> {
    const parsed = labelSchema.safeParse(raw);
    if (!parsed.success) fail("RETURN_LABEL_RESPONSE_INVALID", "unknown");
    const label = parsed.data;
    if (expectedLabelId && label.label_id !== expectedLabelId) fail("RETURN_LABEL_IDENTITY_MISMATCH", "unknown");
    if (label.status !== "completed") fail("RETURN_LABEL_NOT_COMPLETED", "unknown", label.status === "processing");
    if (!label.is_return_label || label.is_international || !label.trackable || label.voided || label.voided_at
      || label.rma_number !== input.rmaNumber || label.carrier_id !== input.carrierId || label.service_code !== input.serviceCode
      || label.label_format !== "pdf" || label.label_layout !== "4x6" || label.charge_event !== "carrier_default"
      || (label.external_shipment_id != null && label.external_shipment_id !== input.externalShipmentId)
      || label.packages[0].tracking_number !== label.tracking_number) fail("RETURN_LABEL_IDENTITY_MISMATCH", "unknown");
    assertPackage(label.packages[0], input);
    const shipmentResult = shipmentSchema.safeParse(await request("GET", `/shipments/${encodeURIComponent(label.shipment_id)}`, undefined, signal));
    if (!shipmentResult.success) fail("RETURN_LABEL_SHIPMENT_INVALID", "unknown");
    const shipment = shipmentResult.data;
    if (shipment.shipment_id !== label.shipment_id || shipment.external_shipment_id !== input.externalShipmentId
      || shipment.carrier_id !== input.carrierId || shipment.service_code !== input.serviceCode
      || !sameAddress(shipment.ship_from, input.shipFrom) || !sameAddress(shipment.ship_to, input.shipTo)) {
      fail("RETURN_LABEL_IDENTITY_MISMATCH", "unknown");
    }
    assertPackage(shipment.packages[0], input);
    const cost = moneyCents(label.shipment_cost).plus(moneyCents(label.insurance_cost));
    if (!cost.isInteger() || cost.greaterThan(Number.MAX_SAFE_INTEGER)) fail("RETURN_LABEL_AMOUNT_INVALID", "unknown");
    const result = returnLabelRecordSchema.safeParse({
      labelId: label.label_id, shipmentId: label.shipment_id, externalShipmentId: input.externalShipmentId,
      carrierId: label.carrier_id, serviceCode: label.service_code, trackingNumber: label.tracking_number,
      amountCents: cost.toNumber(), currency: "USD", downloadUrl: label.label_download.pdf ?? label.label_download.href,
      labelFormat: "pdf", createdAt: label.created_at,
    });
    if (!result.success) fail("RETURN_LABEL_ARTIFACT_INVALID", "unknown");
    return result.data;
  }

  return {
    async purchase(rawInput, signal) {
      const input = parseInput(rawInput);
      const response = await request("POST", "/labels", buildReturnLabelRequest(input), signal);
      return verify(response, input, signal);
    },
    async recover(rawInput, signal) {
      const input = parseInput(rawInput, "unknown");
      const ids = new Set<string>();
      let total: number | undefined;
      let pages = 1;
      for (let page = 1; page <= pages; page += 1) {
        const params = new URLSearchParams({ external_shipment_id: input.externalShipmentId, page: String(page),
          page_size: String(RECOVERY_PAGE_SIZE), sort_by: "created_at", sort_dir: "asc" });
        const result = listSchema.safeParse(await request("GET", `/labels?${params}`, undefined, signal));
        if (!result.success) fail("RETURN_LABEL_RECOVERY_INCOMPLETE", "unknown");
        const listing = result.data;
        if (listing.total > MAX_RECOVERY_LABELS) fail("RETURN_LABEL_RECOVERY_LIMIT", "unknown");
        const expectedPages = Math.max(1, Math.ceil(listing.total / RECOVERY_PAGE_SIZE));
        if (listing.page !== page || (listing.pages !== expectedPages && !(listing.total === 0 && listing.pages === 0))
          || (total !== undefined && total !== listing.total)
          || listing.labels.length !== Math.min(RECOVERY_PAGE_SIZE, Math.max(0, listing.total - (page - 1) * RECOVERY_PAGE_SIZE))) {
          fail("RETURN_LABEL_RECOVERY_INCOMPLETE", "unknown");
        }
        total = listing.total; pages = expectedPages;
        for (const label of listing.labels) {
          if (ids.has(label.label_id) || (label.external_shipment_id != null && label.external_shipment_id !== input.externalShipmentId)) {
            fail("RETURN_LABEL_RECOVERY_INCOMPLETE", "unknown");
          }
          ids.add(label.label_id);
        }
      }
      // Provider external IDs are correlation keys, not a documented idempotency
      // guarantee. Never pick a first match or infer a missing label was not bought.
      if (ids.size > 1) fail("RETURN_LABEL_RECOVERY_AMBIGUOUS", "unknown");
      const [id] = ids;
      if (!id) return null;
      return verify(await request("GET", `/labels/${encodeURIComponent(id)}`, undefined, signal), input, signal, id);
    },
  };
}

function parseInput(input: unknown, outcome: "rejected" | "unknown" = "rejected"): ReturnLabelInput {
  const result = returnLabelInputSchema.safeParse(input);
  if (!result.success) fail("RETURN_LABEL_INPUT_INVALID", outcome);
  return result.data;
}

export function buildReturnLabelRequest(rawInput: ReturnLabelInput): Record<string, unknown> {
  const input = parseInput(rawInput);
  return {
    is_return_label: true, rma_number: input.rmaNumber, charge_event: "carrier_default",
    label_format: "pdf", label_layout: "4x6", label_download_type: "url",
    shipment: {
      validate_address: "no_validation", external_shipment_id: input.externalShipmentId,
      carrier_id: input.carrierId, service_code: input.serviceCode,
      ship_from: addressBody(input.shipFrom), ship_to: addressBody(input.shipTo),
      packages: [{ package_code: "package", weight: { value: input.parcel.weightGrams, unit: "gram" },
        dimensions: { ...input.parcel.dimensionsInches, unit: "inch" } }],
    },
  };
}

function addressBody(address: ReturnLabelAddress) {
  return {
    name: address.name, phone: address.phone, company_name: address.companyName,
    address_line1: address.addressLine1, address_line2: address.addressLine2, address_line3: address.addressLine3,
    city_locality: address.city, state_province: address.state, postal_code: address.postalCode, country_code: address.countryCode,
  };
}

function sameAddress(actual: z.infer<typeof addressSchema>, expected: ReturnLabelAddress): boolean {
  const canonical = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  const body = addressBody(expected);
  return Object.entries(body).every(([key, value]) => canonical(actual[key as keyof typeof actual]) === canonical(value));
}

function assertPackage(actual: z.infer<typeof packageSchema>, input: ReturnLabelInput): void {
  const gramsPerUnit = { gram: "1", kilogram: "1000", ounce: "28.349523125", pound: "453.59237" };
  if (!new Exact(actual.weight.value).times(gramsPerUnit[actual.weight.unit]).eq(input.parcel.weightGrams)) {
    fail("RETURN_LABEL_MEASUREMENTS_MISMATCH", "unknown");
  }
  for (const axis of ["length", "width", "height"] as const) {
    const value = new Exact(actual.dimensions[axis]);
    const expected = new Exact(input.parcel.dimensionsInches[axis]);
    if (!(actual.dimensions.unit === "centimeter" ? value.eq(expected.times("2.54")) : value.eq(expected))) {
      fail("RETURN_LABEL_MEASUREMENTS_MISMATCH", "unknown");
    }
  }
}

function moneyCents(value: z.infer<typeof moneySchema>): Decimal {
  const amount = new Exact(value.amount);
  if (value.currency.toUpperCase() !== "USD" || amount.isNegative() || amount.decimalPlaces() > 2) {
    fail("RETURN_LABEL_AMOUNT_INVALID", "unknown");
  }
  return amount.times(100);
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    fail("RETURN_LABEL_RESPONSE_TOO_LARGE", "unknown");
  }
  if (!response.body) fail("RETURN_LABEL_RESPONSE_INVALID", "unknown");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail("RETURN_LABEL_RESPONSE_TOO_LARGE", "unknown");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function fail(code: string, outcome: "rejected" | "unknown", retryable = false): never {
  throw new ReturnLabelProviderError(code, outcome, retryable);
}
