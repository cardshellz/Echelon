import { createHash } from "node:crypto";
import { z } from "zod";
import { createProviderRequestDeadline } from "../../provider-request-limits";
import { QuantityProviderRejectionError, recordQuantityProviderResponse,
  type QuantityProviderResponseEvidence } from "../../../inventory-planning/application/quantity-provider-request-evidence";

// eBay's observed per-item error says "Try back after 1 day". A full 24 hours is
// conservative without inventing a calendar-reset timezone. Longer Retry-After wins.
export const EBAY_ITEM_REVISION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const EBAY_REJECTION_RETRY_MS = 60 * 1000;
const errorsSchema = z.object({ errors: z.array(z.object({
  errorId: z.number().int().nonnegative().safe(), category: z.string().optional(), message: z.string(),
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
export function classifyEbayQuantityResponse(status: number, body: unknown): { rejected: boolean; dailyLimit: boolean; errorCodes: string[] } {
  const parsed = errorsSchema.safeParse(body);
  const errors = parsed.success ? parsed.data.errors : [];
  const isDaily = (error: typeof errors[number]): boolean => error.errorId === 25001
    && /exceeded your maximum call limit of 250 for item per day/i.test(error.message);
  const dailyLimit = status === 400 && errors.length > 0 && errors.every(isDaily);
  const validation = status === 400 && errors.length > 0 && errors.every(error => error.category === "REQUEST");
  return { rejected: dailyLimit || validation || [401, 403, 429].includes(status), dailyLimit,
    errorCodes: errors.map(error => String(error.errorId)) };
}

export interface EbayQuantityHttpInput {
  url: string; method: string; path: string; body?: unknown; headers: Record<string, string>;
  request: typeof fetch; now: () => Date;
  onFailure?: (status: number, body: string) => Promise<void>;
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
    const classification = classifyEbayQuantityResponse(response.status, body);
    // 202 is acceptance, not completion; unexpected multi-status/partial responses
    // cannot prove a quantity mutation finished merely because Response.ok is true.
    const topLevelErrors = body && typeof body === "object" && "errors" in body
      && (!Array.isArray(body.errors) || body.errors.length > 0);
    const completed = [200,201,204].includes(response.status) && validJson && !topLevelErrors;
    const evidence: QuantityProviderResponseEvidence = {
      outcome: completed ? "completed" : classification.rejected ? "rejected" : "uncertain",
      httpStatus: response.status, providerRequestId,
      responseHash: createHash("sha256").update(text).digest("hex"), errorCodes: classification.errorCodes,
      retryNotBefore: classification.rejected ? ebayRetryNotBefore(response.headers.get("Retry-After"), input.now(),
        classification.dailyLimit ? EBAY_ITEM_REVISION_COOLDOWN_MS : EBAY_REJECTION_RETRY_MS) : null,
      // HTTP throttling/auth failures can affect every item using this credential.
      // Without narrower provider evidence, conservatively pause the whole account.
      cooldownScope: classification.rejected ? ([401,403,429].includes(response.status) ? "account" : "item") : null,
    };
    recordQuantityProviderResponse(evidence);
    recorded = true;
    // Preserve owning adapters' credential-health/error contracts. The captured
    // response remains independently available if an adapter wraps this failure.
    if (!response.ok) await input.onFailure?.(response.status,text);
    if (classification.rejected) throw new QuantityProviderRejectionError(
      classification.dailyLimit ? "EBAY_QUANTITY_DAILY_LIMIT" : "EBAY_QUANTITY_REJECTED",
      `eBay quantity request rejected (HTTP ${response.status}; codes ${classification.errorCodes.join(",") || "not supplied"}).`);
    if (!completed) {
      throw Object.assign(new Error(`eBay quantity request has an uncertain outcome (HTTP ${response.status}).`),
        { code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
    }
    return { value: (text ? body : undefined) as T, status: response.status };
  } catch (error) {
    if (!recorded) recordQuantityProviderResponse({ outcome: "uncertain", httpStatus: responseStatus,
      providerRequestId, responseHash: null, errorCodes: [], retryNotBefore: null, cooldownScope: null });
    if (deadline.signal.aborted) throw deadline.signal.reason;
    throw error;
  } finally { deadline.dispose(); }
}
