import { createHash } from "node:crypto";
import { z } from "zod";
import { createProviderRequestDeadline } from "../../provider-request-limits";
import { readEbayBulkQuantityResponse } from "./ebay-quantity-update";
import { QuantityProviderRejectionError, recordQuantityProviderResponse,
  type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

// eBay's observed per-item error says "Try back after 1 day". A full 24 hours is
// conservative without inventing a calendar-reset timezone. Longer Retry-After wins.
export const EBAY_ITEM_REVISION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const EBAY_REJECTION_RETRY_MS = 60 * 1000;
const errorsSchema = z.object({ errors: z.array(z.object({
  errorId: z.number().int().nonnegative().safe(), category: z.string().optional(), message: z.string().optional(),
  longMessage: z.string().optional(),
})).min(1).max(25) });

export function ebayRetryNotBefore(value: string | null, observedAt: Date, minimumMs: number): string {
  const observed = observedAt.getTime();
  if (!Number.isFinite(observed) || !Number.isSafeInteger(minimumMs) || minimumMs < 0) throw new Error("Invalid eBay retry clock or duration.");
  let requested = observed;
  if (value && /^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    // An unrepresentable instruction fails closed instead of shortening the wait.
    if (!Number.isSafeInteger(seconds) || observed + seconds * 1000 > Date.parse("9999-12-31T23:59:59.999Z")) {
      throw new Error("The eBay retry instruction cannot be represented safely.");
    }
    requested = observed + seconds * 1000;
  } else if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) requested = parsed;
  }
  return new Date(Math.max(observed + minimumMs, requested)).toISOString();
}

/** Narrow evidence classification; 408, 5xx, generic APPLICATION errors and malformed bodies stay uncertain. */
/**
 * eBay's REQUEST and BUSINESS error categories are eBay refusing the request
 * as sent (bad input, or a business rule such as a missing product
 * identifier at publish): nothing was written, so a 400 carrying only these
 * is a rejection. APPLICATION is an eBay-side failure whose effect is unknown,
 * and a missing category proves nothing; both stay uncertain and block the
 * scope until retained response evidence or explicit recovery permits a fresh write.
 */
const PROVIDER_REFUSAL_CATEGORIES: ReadonlySet<string> = new Set(["REQUEST", "BUSINESS"]);

function isProviderRefusalCategory(category: string | undefined): boolean {
  return category !== undefined && PROVIDER_REFUSAL_CATEGORIES.has(category);
}

export function classifyEbayQuantityResponse(status: number, body: unknown): { rejected: boolean; dailyLimit: boolean; errorCodes: string[]; rejectionCode: string } {
  const parsed = errorsSchema.safeParse(body);
  const errors = parsed.success ? parsed.data.errors : [];
  const isDaily = (error: typeof errors[number]): boolean => error.errorId === 25001
    && /exceeded your maximum call limit of 250 for item per day/i.test(error.message ?? "");
  const dailyLimit = status === 400 && errors.length > 0 && errors.every(isDaily);
  const validation = status === 400 && errors.length > 0 && errors.every(error => isProviderRefusalCategory(error.category));
  // HTTP 401 establishes rejected authentication, not why the token failed.
  // Only eBay's documented OAuth permission error establishes a scope problem;
  // other 403s may concern seller/resource access and must not promise reconnect.
  // https://www.developer.ebay.com/develop/api/sell/error_codes
  const missingScope = status === 403 && errors.length > 0
    && errors.every(error => error.errorId === 1100 && error.category === "REQUEST");
  const rejectionCode = status === 401 ? "EBAY_AUTH_REQUIRED"
    : missingScope ? "EBAY_OAUTH_SCOPE_MISSING"
    : status === 403 ? "EBAY_PROVIDER_ACCESS_DENIED"
    : status === 429 ? "EBAY_PROVIDER_RATE_LIMITED"
    : dailyLimit ? "EBAY_QUANTITY_DAILY_LIMIT" : "EBAY_QUANTITY_REJECTED";
  return { rejected: dailyLimit || validation || [401, 403, 429].includes(status), dailyLimit,
    errorCodes: errors.map(error => String(error.errorId)), rejectionCode };
}

/** Completion of a synchronous request and successful application are distinct.
 * A fully identified bulk response may finish with some operations failed. */
export function interpretEbayQuantityResponse(status: number, body: unknown, path: string, requestBody?: unknown) {
  const classification = classifyEbayQuantityResponse(status, body);
  const topErrors = errorsSchema.safeParse(body);
  const errorsPresent = body !== null && typeof body === "object" && "errors" in body
    && (!Array.isArray(body.errors) || body.errors.length > 0);
  const base = { ...classification, completed: [200,201,204].includes(status) && !errorsPresent,
    requestTerminated: classification.rejected || (status >= 400 && status !== 408 && topErrors.success),
    diagnosticBody: body };
  if (path !== "/sell/inventory/v1/bulk_update_price_quantity") {
    return { ...base, requestTerminated: base.completed || base.requestTerminated };
  }
  if (![200,207,400,500].includes(status) || errorsPresent) return { ...base, completed: false };
  const results = readEbayBulkQuantityResponse(body, requestBody);
  if (!results || results.some(result => !result.complete)) return { ...base, completed: false, requestTerminated: false };
  const operations = results.flatMap(result => result.operations);
  const errors = results.flatMap(result => result.errors);
  const errorBody = { errors };
  const failures = operations.filter(operation => ![200,201,204].includes(operation.statusCode ?? 0) || operation.errors?.length);
  const refusals = failures.map(operation => classifyEbayQuantityResponse(operation.statusCode ?? 0, { errors: operation.errors ?? [] }));
  const completed = [200,207].includes(status) && results.every(result => result.confirmed);
  const rejected = failures.length === operations.length && refusals.every(failure => failure.rejected);
  // Identity-complete per-operation 4xx responses terminate those operations;
  // 408/202 and server failures without a structured error remain unknown.
  const requestTerminated = operations.every(operation => {
    const operationStatus = operation.statusCode ?? 0;
    return [200,201,204].includes(operationStatus) || (operationStatus >= 400 && operationStatus < 500 && operationStatus !== 408)
      || (operationStatus >= 500 && errorsSchema.safeParse({ errors: operation.errors }).success);
  });
  const dailyLimit = refusals.some(failure => failure.dailyLimit);
  const rejectionCode = dailyLimit ? "EBAY_QUANTITY_DAILY_LIMIT"
    : refusals.find(failure => failure.rejectionCode !== "EBAY_QUANTITY_REJECTED")?.rejectionCode ?? "EBAY_QUANTITY_REJECTED";
  return { rejected, completed, requestTerminated, dailyLimit, rejectionCode,
    errorCodes: [...new Set(errors.flatMap(error => error.errorId === undefined ? [] : [String(error.errorId)]))].slice(0,25),
    diagnosticBody: { errors: errorBody.errors.slice(0,25) } };
}

export interface EbayQuantityHttpInput {
  url: string; method: string; path: string; body?: unknown; headers: Record<string, string>;
  request: typeof fetch; now: () => Date;
  onFailure?: (status: number, body: string) => Promise<void>;
}
export class EbayQuantityResponseUncertainError extends Error {
  readonly code = "EBAY_QUANTITY_RESPONSE_UNCERTAIN";
  constructor(readonly httpStatus: number, message: string) {
    super(message);
    this.name = "EbayQuantityResponseUncertainError";
  }
}

/** Exactly one HTTP mutation. Ambiguous transport/5xx results are never replayed inside an owner. */
export async function executeEbayQuantityHttp<T>(input: EbayQuantityHttpInput): Promise<T> {
  return (await executeEbayQuantityHttpResponse<T>(input)).value;
}

export async function executeEbayQuantityHttpResponse<T>(input: EbayQuantityHttpInput): Promise<{ value: T; status: number }> {
  const deadline = createProviderRequestDeadline();
  let responseStatus: number | null = null;
  let providerRequestId: string | null = null;
  let recorded = false;
  try {
    const response = await input.request(input.url, { method: input.method, signal: deadline.signal, redirect: "error",
      headers: input.headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
    responseStatus = response.status;
    const requestId = response.headers.get("x-ebay-c-request-id") ?? response.headers.get("x-ebay-request-id");
    providerRequestId = requestId && /^[\x21-\x7e]{1,200}$/.test(requestId) ? requestId : null;
    const text = await response.text();
    let body: unknown = null; let validJson = text.length === 0;
    if (text) { try { body = JSON.parse(text); validJson = true; } catch { /* Persist hash; malformed response is not terminal success. */ } }
    const classification = interpretEbayQuantityResponse(response.status, body, input.path, input.body);
    const diagnostics = safeEbayErrorMessage(classification.diagnosticBody);
    const completed = validJson && classification.completed;
    const evidence: QuantityProviderResponseEvidence = {
      outcome: completed ? "completed" : classification.rejected ? "rejected" : "uncertain",
      httpStatus: response.status, providerRequestId,
      responseHash: createHash("sha256").update(text).digest("hex"), errorCodes: classification.errorCodes,
      requestTerminated: validJson && classification.requestTerminated,
      retryNotBefore: classification.rejected || classification.dailyLimit ? ebayRetryNotBefore(response.headers.get("Retry-After"), input.now(),
        classification.dailyLimit ? EBAY_ITEM_REVISION_COOLDOWN_MS : EBAY_REJECTION_RETRY_MS) : null,
      // HTTP throttling/auth failures can affect every item using this credential.
      // Without narrower provider evidence, conservatively pause the whole account.
      cooldownScope: classification.rejected || classification.dailyLimit ? ([401,403,429].includes(response.status) ? "account" : "item") : null,
    };
    recordQuantityProviderResponse(evidence);
    recorded = true;
    // Preserve owning adapters' credential-health/error contracts. The captured
    // response remains independently available if an adapter wraps this failure.
    if (!response.ok) await input.onFailure?.(response.status,text);
    if (classification.rejected) throw new QuantityProviderRejectionError(
      classification.rejectionCode,
      `eBay quantity request rejected (HTTP ${response.status}; codes ${classification.errorCodes.join(",") || "not supplied"}).${diagnostics}`);
    if (!completed) {
      throw new EbayQuantityResponseUncertainError(response.status,
        `eBay quantity request has an uncertain outcome (HTTP ${response.status}; codes ${classification.errorCodes.join(",") || "not supplied"}).${diagnostics}`);
    }
    return { value: (text ? body : undefined) as T, status: response.status };
  } catch (error) {
    if (!recorded) recordQuantityProviderResponse({ outcome: "uncertain", httpStatus: responseStatus,
      providerRequestId, responseHash: null, errorCodes: [], retryNotBefore: null, cooldownScope: null });
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally { deadline.dispose(); }
}

/** Retain actionable provider diagnostics in the listing job's immutable failure
 * event. Never retain raw response bodies, headers, credentials or parameter values. */
export function safeEbayErrorMessage(body: unknown): string {
  const parsed = errorsSchema.safeParse(body);
  if(!parsed.success) return "";
  return " " + parsed.data.errors.map(error => `${error.errorId} ${error.category ?? "UNKNOWN"}: ${error.longMessage ?? error.message ?? "No error description supplied"}`)
    .join("; ").replace(/https?:\/\/\S+/gi,"[URL]").replace(/Bearer\s+\S+/gi,"Bearer [redacted]")
    .replace(/(access_token|refresh_token|client_secret|authorization)[\s:=]+[^\s,;]+/gi,"$1 [redacted]")
    .replace(/[\u0000-\u001f\u007f]/g," ").slice(0,700);
}
