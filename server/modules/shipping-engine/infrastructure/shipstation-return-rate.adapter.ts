import Decimal from "decimal.js";
import { z } from "zod";
import {
  returnLabelProviderIdSchema,
  type ReturnLabelAddress,
} from "../application/return-label-provider.port";
import {
  MAX_RETURN_RATE_CANDIDATES,
  ReturnRateProviderError,
  returnRateInputSchema,
  returnRateResultSchema,
  type ReturnRateCandidate,
  type ReturnRateExclusion,
  type ReturnRateInput,
  type ReturnRateProvider,
  type ReturnRateResult,
} from "../application/return-rate-provider.port";
import { shipStationReturnWeightPounds } from "./shipstation-return-weight";

const RATES_URL = "https://api.shipstation.com/v2/rates";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 2_097_152;
const Exact = Decimal.clone({ precision: 50 });
const serviceCode = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  .max(100);
const messages = z.array(z.string().max(2_048)).max(100);
const identitySchema = z.object({
  carrier_id: returnLabelProviderIdSchema,
  service_code: serviceCode,
});
const dispositionSchema = identitySchema.extend({
  validation_status: z.enum(["valid", "invalid", "has_warnings", "unknown"]),
  error_messages: messages,
});
const numeric = z.union([
  z.number().finite(),
  z
    .string()
    .max(50)
    .regex(/^\d+(?:\.\d+)?$/),
]);
const moneySchema = z.object({ currency: z.string().max(3), amount: numeric });
const rateSchema = dispositionSchema.extend({
  rate_id: z.null(),
  rate_type: z.literal("quick"),
  carrier_code: serviceCode,
  trackable: z.boolean(),
  package_type: z.string().min(1).max(100).nullable(),
  warning_messages: messages,
  shipping_amount: moneySchema,
  insurance_amount: moneySchema,
  confirmation_amount: moneySchema,
  other_amount: moneySchema,
  tax_amount: moneySchema.nullish(),
});
const responseSchema = z.object({
  rate_response: z.object({
    status: z.enum(["working", "completed", "partial", "error"]),
    rates: z.array(z.unknown()).max(MAX_RETURN_RATE_CANDIDATES),
    invalid_rates: z.array(z.unknown()).max(MAX_RETURN_RATE_CANDIDATES),
    errors: z.array(z.unknown()).max(MAX_RETURN_RATE_CANDIDATES),
  }),
});

export interface ShipStationReturnRateAdapterConfig {
  apiKey: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Full return quotes, not estimates or purchases. Quick rates do not persist a provider shipment.
 * https://docs.shipstation.com/rate-shopping documents rate_options.is_return and rate_type=quick.
 * Return purchases still require the separate POST /v2/labels is_return_label=true path.
 */
export function createShipStationReturnRateAdapter(
  config: ShipStationReturnRateAdapterConfig,
): ReturnRateProvider {
  const credential = z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .regex(/^[^\s\u0000-\u001f\u007f]+$/)
    .safeParse(config.apiKey);
  const timeout = z
    .number()
    .int()
    .min(1)
    .max(30_000)
    .safeParse(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!credential.success || !timeout.success)
    fail("RETURN_RATE_CONFIGURATION_INVALID", "configuration");
  const apiKey = credential.data;
  const timeoutMs = timeout.data;
  const fetchFn = config.fetchFn ?? fetch;

  return {
    async quote(rawInput, signal) {
      const parsed = returnRateInputSchema.safeParse(rawInput);
      if (!parsed.success) fail("RETURN_RATE_INPUT_INVALID", "rejected");
      const input = parsed.data;
      const body = JSON.stringify(buildReturnRateRequest(input));
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES)
        fail("RETURN_RATE_INPUT_TOO_LARGE", "rejected");
      if (signal?.aborted) fail("RETURN_RATE_CANCELLED", "transient");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        const abort = (code: string): void => {
          controller.abort();
          reject(new ReturnRateProviderError(code, "transient"));
        };
        cancel = () => abort("RETURN_RATE_CANCELLED");
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          return;
        }
        timer = setTimeout(() => abort("RETURN_RATE_TIMEOUT"), timeoutMs);
      });
      const work = async (): Promise<ReturnRateResult> => {
        if (controller.signal.aborted)
          fail("RETURN_RATE_CANCELLED", "transient");
        let response: Response;
        try {
          response = await fetchFn(RATES_URL, {
            method: "POST",
            headers: {
              "API-Key": apiKey,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body,
            signal: controller.signal,
            redirect: "error",
            cache: "no-store",
          });
        } catch {
          fail("RETURN_RATE_TRANSPORT_FAILED", "transient");
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          if (response.status === 401 || response.status === 403)
            fail("RETURN_RATE_CREDENTIAL_REJECTED", "configuration");
          fail(
            "RETURN_RATE_HTTP_ERROR",
            response.status === 429 || response.status >= 500
              ? "transient"
              : "rejected",
          );
        }
        return normalizeReturnRateResponse(
          await readJson(response, controller.signal),
          input,
        );
      };
      try {
        return await Promise.race([work(), deadline]);
      } catch (error) {
        if (error instanceof ReturnRateProviderError) throw error;
        fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (cancel) signal?.removeEventListener("abort", cancel);
        controller.abort();
      }
    },
  };
}

export function buildReturnRateRequest(
  rawInput: ReturnRateInput,
): Record<string, unknown> {
  const parsed = returnRateInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("RETURN_RATE_INPUT_INVALID", "rejected");
  const { shipment, carrierIds } = parsed.data;
  const weightPounds = shipStationReturnWeightPounds(shipment.parcel.weightGrams);
  if (weightPounds === null) fail("RETURN_RATE_INPUT_INVALID", "rejected");
  return {
    rate_options: {
      carrier_ids: carrierIds,
      package_types: ["package"],
      preferred_currency: "usd",
      is_return: true,
      rate_type: "quick",
    },
    shipment: {
      validate_address: "no_validation",
      ship_from: addressBody(shipment.shipFrom),
      ship_to: addressBody(shipment.shipTo),
      packages: [
        {
          package_code: "package",
          weight: { value: weightPounds, unit: "pound" },
          dimensions: { ...shipment.parcel.dimensionsInches, unit: "inch" },
        },
      ],
    },
  };
}

export function normalizeReturnRateResponse(
  payload: unknown,
  rawInput: ReturnRateInput,
): ReturnRateResult {
  const input = returnRateInputSchema.safeParse(rawInput);
  if (!input.success) fail("RETURN_RATE_INPUT_INVALID", "rejected");
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
  const response = parsed.data.rate_response;
  if (response.status !== "completed" || response.errors.length > 0)
    fail("RETURN_RATE_RESPONSE_INCOMPLETE", "transient");
  if (
    response.rates.length + response.invalid_rates.length >
    MAX_RETURN_RATE_CANDIDATES
  )
    fail("RETURN_RATE_RESPONSE_LIMIT", "invalid_response");
  const accounts = new Set(input.data.carrierIds);
  const seen = new Set<string>();
  const rates: ReturnRateCandidate[] = [];
  const exclusions: ReturnRateExclusion[] = [];
  for (const [entries, invalidList] of [
    [response.rates, false],
    [response.invalid_rates, true],
  ] as const) {
    for (const entry of entries) {
      const disposition = dispositionSchema.safeParse(entry);
      if (!disposition.success)
        fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
      const row = disposition.data;
      const key = `${row.carrier_id}:${row.service_code}`;
      if (!accounts.has(row.carrier_id) || seen.has(key))
        fail("RETURN_RATE_IDENTITY_MISMATCH", "invalid_response");
      seen.add(key);
      const exclude = (code: ReturnRateExclusion["code"]): void => {
        exclusions.push({
          carrierId: row.carrier_id,
          serviceCode: row.service_code,
          code,
        });
      };
      if (row.validation_status === "invalid") {
        exclude("RETURN_RATE_SERVICE_INVALID");
        continue;
      }
      if (
        invalidList ||
        row.validation_status === "unknown" ||
        row.error_messages.length > 0
      )
        fail("RETURN_RATE_RESPONSE_INCOMPLETE", "invalid_response");
      const rate = rateSchema.safeParse(entry);
      if (!rate.success)
        fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
      const value = rate.data;
      if (!value.trackable) {
        exclude("RETURN_RATE_NOT_TRACKABLE");
        continue;
      }
      if (value.package_type !== null && value.package_type !== "package") {
        exclude("RETURN_RATE_PACKAGE_UNSUPPORTED");
        continue;
      }
      const amounts = {
        shippingCents: moneyCents(value.shipping_amount),
        insuranceCents: moneyCents(value.insurance_amount),
        confirmationCents: moneyCents(value.confirmation_amount),
        otherCents: moneyCents(value.other_amount),
      };
      // The supported input is domestic. A nonzero international tax cannot be
      // silently omitted or double-counted against the documented four-part total.
      if (value.tax_amount && moneyCents(value.tax_amount) !== 0)
        fail("RETURN_RATE_TAX_UNSUPPORTED", "invalid_response");
      const total = new Exact(amounts.shippingCents)
        .plus(amounts.insuranceCents)
        .plus(amounts.confirmationCents)
        .plus(amounts.otherCents);
      if (total.greaterThan(Number.MAX_SAFE_INTEGER))
        fail("RETURN_RATE_AMOUNT_INVALID", "invalid_response");
      rates.push({
        carrierId: value.carrier_id,
        carrierCode: value.carrier_code,
        serviceCode: value.service_code,
        amountCents: total.toNumber(),
        currency: "USD",
        rateId: null,
        rateType: "quick",
        packageType: value.package_type,
        trackable: true,
        validationStatus: row.validation_status,
        warningCount: value.warning_messages.length,
        amounts,
      });
    }
  }
  const result = returnRateResultSchema.safeParse({
    status: "completed",
    rates,
    exclusions,
  });
  if (!result.success) fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
  return result.data;
}

function moneyCents(money: z.infer<typeof moneySchema>): number {
  if (money.currency.toUpperCase() !== "USD")
    fail("RETURN_RATE_CURRENCY_UNSUPPORTED", "invalid_response");
  const amount = new Exact(money.amount).times(100);
  if (
    !amount.isFinite() ||
    amount.isNegative() ||
    !amount.isInteger() ||
    amount.greaterThan(Number.MAX_SAFE_INTEGER)
  ) {
    fail("RETURN_RATE_AMOUNT_INVALID", "invalid_response");
  }
  return amount.toNumber();
}

function addressBody(address: ReturnLabelAddress): Record<string, unknown> {
  return {
    name: address.name,
    ...(address.phone ? { phone: address.phone } : {}),
    ...(address.companyName ? { company_name: address.companyName } : {}),
    address_line1: address.addressLine1,
    ...(address.addressLine2 ? { address_line2: address.addressLine2 } : {}),
    ...(address.addressLine3 ? { address_line3: address.addressLine3 } : {}),
    city_locality: address.city,
    state_province: address.state,
    postal_code: address.postalCode,
    country_code: address.countryCode,
  };
}

async function readJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)
  ) {
    void response.body?.cancel().catch(() => undefined);
    fail("RETURN_RATE_RESPONSE_LIMIT", "invalid_response");
  }
  const reader = response.body?.getReader();
  if (!reader) fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) fail("RETURN_RATE_CANCELLED", "transient");
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        fail("RETURN_RATE_RESPONSE_LIMIT", "invalid_response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof ReturnRateProviderError) throw error;
    fail("RETURN_RATE_RESPONSE_INVALID", "invalid_response");
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function fail(
  code: string,
  failureClass: ReturnRateProviderError["failureClass"],
): never {
  throw new ReturnRateProviderError(code, failureClass);
}
