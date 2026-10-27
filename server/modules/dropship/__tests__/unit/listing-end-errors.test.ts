import { describe, expect, it } from "vitest";
import {
  classifyAdmissionRefusal,
  classifyCredentialError,
  classifyInspectionIssue,
  classifyInspectionThrow,
  classifyWithdrawRejection,
  decideTransientRetry,
  deferralDueAt,
  isListingEndCode,
  LISTING_END_BACKOFF_MS,
  LISTING_END_CODE_CLASSES,
  LISTING_END_CODES,
  LISTING_END_DEFERRAL_CODES,
  LISTING_END_DEFERRAL_DELAY_MS,
  LISTING_END_ENDED_CODES,
  LISTING_END_FATAL_CODES,
  LISTING_END_MAX_ATTEMPTS,
  LISTING_END_MESSAGES,
  LISTING_END_PERMANENT_CODES,
  LISTING_END_SUPERSEDED_CODES,
  LISTING_END_TRANSIENT_CODES,
  listingEndClassOf,
  listingEndErrorFacts,
  withdrawOutcomeText,
} from "../../domain/listing-end-errors";

/** The end worker's classes (PLAN-C v4.1 §5.6, §12; SAF-5, FID-9): every code in exactly one class, each input to its class. */
const C = LISTING_END_CODES;
const NOW = new Date("2026-10-26T09:00:00.000Z");

describe("every listing end code has exactly one class (§5.6)", () => {
  it("puts every code in one class list, and no code in two", () => {
    const lists = [LISTING_END_DEFERRAL_CODES, LISTING_END_TRANSIENT_CODES, LISTING_END_PERMANENT_CODES, LISTING_END_FATAL_CODES,
      LISTING_END_SUPERSEDED_CODES, LISTING_END_ENDED_CODES].flat();
    expect(new Set(lists).size).toBe(lists.length);
    expect([...lists].sort()).toEqual(Object.values(C).sort());
    expect(Object.keys(LISTING_END_CODE_CLASSES).sort()).toEqual(Object.values(C).sort());
  });

  it.each([
    [C.waitingForPush, "deferral"], [C.storeNotConnected, "deferral"], [C.storeAccountUnverified, "deferral"],
    [C.remoteBusy, "deferral"], [C.quantityBusy, "deferral"], [C.publicationStopped, "deferral"], [C.providerCooldown, "deferral"],
    [C.breakerOpen, "deferral"], [C.lockBusy, "deferral"], [C.capReached, "deferral"],
    [C.readFailed, "transient"], [C.priorQuantityUnresolved, "transient"], [C.quantityRefused, "transient"],
    [C.providerThrottled, "transient"], [C.readbackPending, "transient"], [C.transient, "transient"],
    [C.rejected, "permanent"], [C.accountChanged, "permanent"], [C.identityMismatch, "permanent"], [C.identityMissing, "permanent"],
    [C.sharedListing, "permanent"], [C.readRefused, "permanent"], [C.withdrawUncertain, "permanent"],
    [C.retriesExhausted, "permanent"], [C.invariantBroken, "permanent"], [C.credentialUnusable, "permanent"],
    [C.tickFailed, "fatal"],
    [C.archived, "superseded"], [C.rePicked, "superseded"], [C.alreadyEnded, "superseded"], [C.nothingListed, "superseded"],
    [C.supersededBySelection, "superseded"],
    [C.notPublishedOnEbay, "ended"], [C.endedByStaff, "ended"],
  ] as const)("%s is %s", (code, klass) => {
    expect(listingEndClassOf(code)).toBe(klass);
    expect(isListingEndCode(code)).toBe(true);
    expect(LISTING_END_MESSAGES[code].length).toBeGreaterThan(10);
  });

  it("uses the namespaced codes of §12", () => {
    for (const code of Object.values(C)) expect(code).toMatch(/^DROPSHIP_LISTING_END_[A-Z_]+$/);
    expect(isListingEndCode("DROPSHIP_LISTING_END_SOMETHING_ELSE")).toBe(false);
    expect(isListingEndCode(undefined)).toBe(false);
  });

  it("waits each deferral's fixed delay: 60 s, 6 h, 30 s, 60 s, 15 min", () => {
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.waitingForPush]).toBe(60_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.storeNotConnected]).toBe(21_600_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.storeAccountUnverified]).toBe(21_600_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.remoteBusy]).toBe(30_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.quantityBusy]).toBe(60_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.publicationStopped]).toBe(900_000);
    expect(LISTING_END_DEFERRAL_DELAY_MS[C.lockBusy]).toBe(60_000);
    expect(deferralDueAt(C.remoteBusy, NOW)).toEqual(new Date(NOW.getTime() + 30_000));
    // A later "until" (eBay's retry time, the breaker's half-open time) wins; an earlier one does not shorten the wait.
    const later = new Date(NOW.getTime() + 7_200_000);
    expect(deferralDueAt(C.providerCooldown, NOW, later)).toEqual(later);
    expect(deferralDueAt(C.providerCooldown, NOW, new Date(NOW.getTime() - 1))).toEqual(new Date(NOW.getTime() + 60_000));
  });
});

describe("decideTransientRetry (§5.6)", () => {
  it("backs off 1 min, 5 min, 15 min, 1 h, then 6 h, attempt by attempt, the claim's attempt counted", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((attemptCount) => {
      const decided = decideTransientRetry({ attemptCount, now: NOW });
      if (decided.outcome !== "retry") throw new Error("expected a retry");
      expect(decided.attemptCount).toBe(attemptCount + 1);
      return decided.nextAttemptAt.getTime() - NOW.getTime();
    });
    expect(delays).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000]);
    expect(LISTING_END_BACKOFF_MS).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000]);
  });

  it("exhausts when the next attempt would be the 11th", () => {
    expect(LISTING_END_MAX_ATTEMPTS).toBe(10);
    expect(decideTransientRetry({ attemptCount: 9, now: NOW }).outcome).toBe("retry");
    expect(decideTransientRetry({ attemptCount: 10, now: NOW })).toEqual({ outcome: "exhausted" });
  });

  it("uses a fixed delay when the code gives one (READBACK_PENDING, 60 s)", () => {
    const decided = decideTransientRetry({ attemptCount: 7, now: NOW, fixedDelayMs: 60_000 });
    expect(decided).toEqual({ outcome: "retry", attemptCount: 8, nextAttemptAt: new Date(NOW.getTime() + 60_000) });
  });
});

describe("admission refusals (SAF-5): nothing was sent", () => {
  it.each([
    ["PUBLICATION_SCOPE_BUSY", C.quantityBusy],
    ["QUANTITY_PUBLICATION_DRAIN_BUSY", C.quantityBusy],
    ["PUBLICATION_ADMISSION_CAPACITY_BUSY", C.quantityBusy],
    ["PUBLICATION_GLOBAL_STOP_ACTIVE", C.publicationStopped],
    ["QUANTITY_PUBLICATION_SUPPRESSED", C.publicationStopped],
    ["PUBLICATION_PROVIDER_COOLDOWN", C.providerCooldown],
    ["PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", C.storeAccountUnverified],
    ["PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", C.priorQuantityUnresolved],
    ["PUBLICATION_SOMETHING_NEW", C.quantityRefused],
  ])("%s → %s", (code, expected) => {
    const failure = classifyAdmissionRefusal({ code });
    expect(failure.code).toBe(expected);
    expect(failure.detail).toEqual({ admissionCode: code });
  });

  it("is a deferral (no attempt counted) except an unsettled request and an unknown refusal, which are transient", () => {
    const classes = ["PUBLICATION_SCOPE_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY",
      "PUBLICATION_GLOBAL_STOP_ACTIVE", "QUANTITY_PUBLICATION_SUPPRESSED", "PUBLICATION_PROVIDER_COOLDOWN",
      "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED"].map((code) => listingEndClassOf(classifyAdmissionRefusal({ code }).code));
    expect(new Set(classes)).toEqual(new Set(["deferral"]));
    expect(listingEndClassOf(classifyAdmissionRefusal({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" }).code)).toBe("transient");
    expect(listingEndClassOf(classifyAdmissionRefusal({ code: "PUBLICATION_SOMETHING_NEW" }).code)).toBe("transient");
  });

  it("waits a provider cooldown until eBay's own retry time, and its default when the time is missing", () => {
    expect(classifyAdmissionRefusal({ code: "PUBLICATION_PROVIDER_COOLDOWN", context: { retryNotBefore: "2026-10-26T11:00:00.000Z" } }).until)
      .toEqual(new Date("2026-10-26T11:00:00.000Z"));
    expect(classifyAdmissionRefusal({ code: "PUBLICATION_PROVIDER_COOLDOWN", context: { retryNotBefore: "not a time" } }).until).toBeNull();
    expect(classifyAdmissionRefusal({ code: "PUBLICATION_PROVIDER_COOLDOWN" }).until).toBeNull();
  });
});

describe("thrown inspection errors (FID-9)", () => {
  it.each([
    [{ code: "DROPSHIP_EBAY_REGISTRATION_STORE_NOT_CONNECTED", status: null }, C.storeNotConnected, false],
    [{ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", status: null }, C.storeNotConnected, false],
    [{ code: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED", status: null }, C.storeNotConnected, false],
    [{ code: "DROPSHIP_EBAY_REGISTRATION_MARKETPLACE_MISMATCH", status: null }, C.identityMismatch, false],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 401 }, C.readFailed, true],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 403 }, C.readFailed, false],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 429 }, C.readFailed, false],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 503 }, C.readFailed, false],
    [{ code: null, status: null }, C.readFailed, false],
    [{ code: "SOMETHING_ELSE", status: null }, C.readFailed, false],
  ] as const)("%j → %s", (facts, code, recordToken) => {
    const failure = classifyInspectionThrow(facts);
    expect(failure.code).toBe(code);
    expect(failure.recordTokenRejection === true).toBe(recordToken);
  });

  it("reads an error's code and status from its own fields or its context, never trusting its type", () => {
    const none = { retryable: null, authFailureStatus: null };
    expect(listingEndErrorFacts(Object.assign(new Error("x"), { code: "A", context: { status: 401 } }))).toEqual({ code: "A", status: 401, ...none });
    expect(listingEndErrorFacts(Object.assign(new Error("x"), { code: "B", httpStatus: 500 }))).toEqual({ code: "B", status: 500, ...none });
    expect(listingEndErrorFacts(Object.assign(new Error("x"), { providerWrite: { httpStatus: 429 } }))).toEqual({ code: null, status: 429, ...none });
    // The shared eBay client's EbayApiRequestError carries its status as statusCode (review WRK-4).
    expect(listingEndErrorFacts(Object.assign(new Error("x"), { statusCode: 404 }))).toEqual({ code: null, status: 404, ...none });
    expect(listingEndErrorFacts(new TypeError("fetch failed"))).toEqual({ code: null, status: null, ...none });
    expect(listingEndErrorFacts("text")).toEqual({ code: null, status: null, ...none });
    expect(listingEndErrorFacts({ code: "", context: { status: 99 } })).toEqual({ code: null, status: null, ...none });
  });

  it("classifies credential loads: a store that cannot be used waits; anything else tries again", () => {
    expect(classifyCredentialError({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", status: null }).code).toBe(C.storeNotConnected);
    expect(classifyCredentialError({ code: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED", status: null }).code).toBe(C.storeNotConnected);
    expect(classifyCredentialError({ code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", status: 500 }))
      .toEqual({ code: C.transient, detail: { causeCode: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", status: 500 } });
  });
});

describe("review: credential errors, send-nothing withdraws and recorded outcomes (WRK-2, WRK-4, WRK-5)", () => {
  const facts = (code: string | null, context: Record<string, unknown> = {}) =>
    listingEndErrorFacts(Object.assign(new Error("x"), { ...(code ? { code } : {}), context }));

  it("reads retryable and the auth failure status from an error's context", () => {
    expect(facts("DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", { retryable: false })).toMatchObject({ retryable: false });
    expect(facts("DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", { retryable: false, authFailureStatus: "needs_reauth", status: 400 }))
      .toMatchObject({ retryable: false, authFailureStatus: "needs_reauth", status: 400 });
  });

  it.each([
    ["DROPSHIP_MARKETPLACE_REGISTRATION_ENVIRONMENT_REQUIRED", { retryable: false }, "DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE"],
    ["DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED", { retryable: false }, "DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE"],
    ["DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH", { retryable: false }, "DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE"],
    ["DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", { retryable: false, authFailureStatus: "needs_reauth" }, "DROPSHIP_LISTING_END_STORE_NOT_CONNECTED"],
    ["DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", { retryable: false }, "DROPSHIP_LISTING_END_STORE_NOT_CONNECTED"],
    ["DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", { retryable: true, status: 503 }, "DROPSHIP_LISTING_END_TRANSIENT"],
  ] as const)("a credential load failing %s %j is %s", (code, context, expected) => {
    const failure = classifyCredentialError(facts(code, context));
    expect(failure.code).toBe(expected);
    expect(failure.detail).toMatchObject({ causeCode: code });
  });

  it("is a permanent code with staff words", () => {
    expect(listingEndClassOf("DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE" as never)).toBe("permanent");
    expect(LISTING_END_MESSAGES["DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE" as keyof typeof LISTING_END_MESSAGES]?.length ?? 0).toBeGreaterThan(10);
  });

  it.each([
    [null, false], ["ok", false], ["rejected_429", false], ["rejected_400", false], ["unsent_503", false], ["unsent_unknown", false],
    ["admission_PUBLICATION_SCOPE_BUSY", false], ["admission_QUANTITY_PUBLICATION_DRAIN_BUSY", false],
    ["admission_PUBLICATION_COMPLETION_CONFLICT", true], ["admission_PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN", true],
    ["network", true], ["uncertain_500", true], ["uncertain_unknown", true], ["something_else", true],
  ] as const)("a recorded outcome %s may have applied: %s", async (outcome, mayHaveApplied) => {
    const errors = await import("../../domain/listing-end-errors") as Record<string, unknown>;
    expect(typeof errors.withdrawOutcomeLeftUncertain).toBe("function");
    expect((errors.withdrawOutcomeLeftUncertain as (value: string | null) => boolean)(outcome)).toBe(mayHaveApplied);
  });

  it.each([
    [401, "DROPSHIP_LISTING_END_READ_FAILED", true], [403, "DROPSHIP_LISTING_END_READ_FAILED", false],
    [429, "DROPSHIP_LISTING_END_READ_FAILED", false], [503, "DROPSHIP_LISTING_END_READ_FAILED", false],
    [null, "DROPSHIP_LISTING_END_READ_FAILED", false], [404, "DROPSHIP_LISTING_END_READ_REFUSED", false],
    [400, "DROPSHIP_LISTING_END_READ_REFUSED", false],
  ] as const)("a withdraw that sent nothing (the offer read before it failed %s) is %s", async (status, expected, recordToken) => {
    const errors = await import("../../domain/listing-end-errors") as Record<string, unknown>;
    expect(typeof errors.classifyWithdrawNotSent).toBe("function");
    const failure = (errors.classifyWithdrawNotSent as (input: { status: number | null; code: string | null }) => { code: string;
      recordTokenRejection?: boolean; detail?: Record<string, unknown> })({ status, code: "EBAY_API_REQUEST_FAILED" });
    expect(failure.code).toBe(expected);
    expect(failure.recordTokenRejection === true).toBe(recordToken);
    expect(failure.detail).toMatchObject({ stage: "withdraw_offer_read" });
  });

  it("writes a send-nothing outcome as unsent_<status>", () => {
    expect(withdrawOutcomeText({ kind: "unsent", status: 503 } as never)).toBe("unsent_503");
    expect(withdrawOutcomeText({ kind: "unsent", status: null } as never)).toBe("unsent_unknown");
  });
});

describe("a SKU's read issue (§5.5 step 4, SAF-11 a)", () => {
  it.each([
    [{ code: "EBAY_REGISTRATION_OFFER_MARKETPLACE_MISMATCH" }, C.identityMismatch],
    [{ code: "EBAY_REGISTRATION_OFFER_SKU_MISMATCH" }, C.identityMismatch],
    [{ code: "EBAY_REGISTRATION_INVENTORY_SKU_MISMATCH" }, C.identityMismatch],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 400 }, C.readRefused],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 404 }, C.readRefused],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 401 }, C.readFailed],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 403 }, C.readFailed],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 429 }, C.readFailed],
    [{ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", status: 500 }, C.readFailed],
    [{ code: "EBAY_REGISTRATION_PROVIDER_RESPONSE_INVALID" }, C.readFailed],
  ])("%j → %s", (issue, code) => {
    expect(classifyInspectionIssue(issue).code).toBe(code);
  });

  it("records the token on a 401 only", () => {
    expect(classifyInspectionIssue({ code: "X", status: 401 }).recordTokenRejection).toBe(true);
    expect(classifyInspectionIssue({ code: "X", status: 403 }).recordTokenRejection).toBe(false);
  });
});

describe("eBay's refusal of the withdraw (§5.5 step 6)", () => {
  it.each([
    [{ rejectionCode: "EBAY_AUTH_REQUIRED", status: 401 }, "throttled", true],
    [{ rejectionCode: "EBAY_OAUTH_SCOPE_MISSING", status: 403 }, "throttled", false],
    [{ rejectionCode: "EBAY_PROVIDER_ACCESS_DENIED", status: 403 }, "throttled", false],
    [{ rejectionCode: "EBAY_PROVIDER_RATE_LIMITED", status: 429 }, "throttled", false],
    [{ rejectionCode: "EBAY_QUANTITY_DAILY_LIMIT", status: 400 }, "throttled", false],
    [{ rejectionCode: "EBAY_QUANTITY_REJECTED", status: 400 }, "refused", false],
    [{ rejectionCode: "EBAY_SHIPPING_POLICY_REJECTED", status: 400 }, "refused", false],
  ] as const)("%j → %s", (input, kind, recordToken) => {
    expect(classifyWithdrawRejection(input)).toEqual({ kind, recordTokenRejection: recordToken });
  });

  it("writes the outcome text within the column's 60 characters", () => {
    expect(withdrawOutcomeText({ kind: "ok" })).toBe("ok");
    expect(withdrawOutcomeText({ kind: "rejected", status: 429 })).toBe("rejected_429");
    expect(withdrawOutcomeText({ kind: "uncertain", status: null })).toBe("uncertain_unknown");
    expect(withdrawOutcomeText({ kind: "network" })).toBe("network");
    expect(withdrawOutcomeText({ kind: "admission", code: "PUBLICATION_SCOPE_BUSY" })).toBe("admission_PUBLICATION_SCOPE_BUSY");
    expect(withdrawOutcomeText({ kind: "admission", code: "X".repeat(80) })).toHaveLength(60);
  });
});
