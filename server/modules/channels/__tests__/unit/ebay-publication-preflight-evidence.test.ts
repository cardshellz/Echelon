import { describe, expect, it } from "vitest";
import { ebayPublicationRequestJournalContract, validateEbayPublicationStageContract,
  proveLegacyEbayPublicationPreflight, type EbayPublicationStageEvent } from "../../ebay-publication-preflight-evidence";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

function fixture() {
  const start: EbayPublicationStageEvent = { id: "100", revision: "3", event: "stage_started",
    createdAt: "2026-10-16T13:03:19.825Z", evidence: { key: "publish", preparedIntentHash: "a".repeat(64) } };
  const next: EbayPublicationStageEvent = { id: "101", revision: "3", event: "awaiting_evidence",
    createdAt: "2026-10-16T13:03:21.085Z", evidence: { code: "EBAY_LISTING_SYNC_FAILED",
      message: 'eBay API GET /sell/inventory/v1/offer?sku=P5&marketplace_id=EBAY_US failed (500): {"errors":[{"errorId":25001,"domain":"API_INVENTORY","subdomain":"Selling","category":"System","message":"A system error has occurred."}]}' } };
  return { jobId: "1e4fae5d-ce57-4d72-817d-9dc714b4a877", target: structuredClone(syncIdentity), start, next };
}

describe("historical publication preparation proof", () => {
  it("recognizes the exact first-member read failure and hashes the original event sequence", () => {
    const input = fixture();
    const proof = proveLegacyEbayPublicationPreflight(input);
    expect(proof).toMatchObject({ jobId: input.jobId, revision: "3", stageEventId: "100", failureEventId: "101",
      failedRequest: { method: "GET", httpStatus: 500, errorCodes: ["25001"] } });
    expect(proof?.sourceEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proveLegacyEbayPublicationPreflight(input)).toEqual(proof);
  });

  it.each([
    ["later member", (value: ReturnType<typeof fixture>) => { value.target.variants.push({ ...value.target.variants[0], variantId: 102, sku: "A1" }); }],
    ["write failure", (value: ReturnType<typeof fixture>) => { value.next.evidence.message = String(value.next.evidence.message).replace("API GET", "API POST"); }],
    ["different marketplace", (value: ReturnType<typeof fixture>) => { value.target.marketplaceId = "EBAY_GB"; }],
    ["different revision", (value: ReturnType<typeof fixture>) => { value.next.revision = "4"; }],
    ["intervening stage", (value: ReturnType<typeof fixture>) => { value.next.event = "stage_completed"; }],
    ["new worker claim", (value: ReturnType<typeof fixture>) => { value.next.event = "claimed"; }],
    ["earlier timestamp", (value: ReturnType<typeof fixture>) => { value.next.createdAt = "2026-10-16T13:00:00.000Z"; }],
    ["wrong stage", (value: ReturnType<typeof fixture>) => { value.start.evidence.key = "group:PACK"; }],
    ["unstructured body", (value: ReturnType<typeof fixture>) => { value.next.evidence.message = String(value.next.evidence.message).split(": {")[0] + ": server error"; }],
    ["mixed provider errors", (value: ReturnType<typeof fixture>) => { value.next.evidence.message = String(value.next.evidence.message).replace('"errorId":25001', '"errorId":25007'); }],
    ["malformed start", (value: ReturnType<typeof fixture>) => { value.start.evidence.preparedIntentHash = "unknown"; }],
  ])("refuses %s instead of clearing uncertain publication", (_label, mutate) => {
    const input = fixture(); mutate(input);
    expect(proveLegacyEbayPublicationPreflight(input)).toBeUndefined();
  });

  it("does not infer a result when the process died without a failure event", () => {
    expect(proveLegacyEbayPublicationPreflight({ ...fixture(), next: null })).toBeUndefined();
  });
});

describe("durable publication-stage journal contract", () => {
  it("binds the group request to the exact marketplace and immutable request body", () => {
    const contract = ebayPublicationRequestJournalContract(syncIdentity);
    expect(contract).toMatchObject({ version: 1, provider: "ebay", method: "POST",
      path: "/sell/inventory/v1/offer/publish_by_inventory_item_group" });
    expect(validateEbayPublicationStageContract(contract, syncIdentity)).toEqual(contract);
    expect(() => validateEbayPublicationStageContract(contract, { ...syncIdentity, marketplaceId: "EBAY_GB" })).toThrow();
    expect(() => validateEbayPublicationStageContract(contract, { ...syncIdentity, groupKey: "other" })).toThrow();
  });
  it("requires the exact retained single offer before a restart can recover its stage", () => {
    const target = { ...syncIdentity, groupKey: null, variants: [syncIdentity.variants[0]] };
    const contract = ebayPublicationRequestJournalContract({ ...target, offerId: target.variants[0].offerId });
    expect(validateEbayPublicationStageContract(contract, target)).toEqual(contract);
    expect(() => validateEbayPublicationStageContract({ ...contract, path: "/sell/inventory/v1/offer/other/publish" }, target)).toThrow();
  });
  it("records a newly created single offer at its first publish stage without guessing an ID", () => {
    const target = { ...syncIdentity, groupKey: null, variants: [{ ...syncIdentity.variants[0], offerId: null }] };
    const contract = ebayPublicationRequestJournalContract({ ...target, offerId: "new-offer" });
    expect(validateEbayPublicationStageContract(contract, target)).toEqual(contract);
    expect(() => ebayPublicationRequestJournalContract(target)).toThrow("exact offer");
  });
  it.each([
    { version: 2 }, { method: "GET" }, { provider: "other" }, { requestHash: "b".repeat(64) },
    { path: "/sell/inventory/v1/bulk_update_price_quantity" },
  ])("rejects a mismatched stage contract %j", change => {
    const contract = ebayPublicationRequestJournalContract(syncIdentity);
    expect(() => validateEbayPublicationStageContract({ ...contract, ...change }, syncIdentity)).toThrow();
  });
});
