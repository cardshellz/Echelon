import { describe, expect, it, vi } from "vitest";
import { assertCurrentEbayQuantityRequestOwner, currentEbayQuantityRequestJournal, withEbayQuantityRequestJournal,
  withEbayQuantityRequestJournalContract } from "../../application/quantity-provider-request-evidence";
import { isCompletedEbayNonPublicationAttempt, legacyEbayPublicationPreflightProofSchema, preflightEvidenceHash,
  terminalEbayPublicationPreparationEvidence } from "../../domain/ebay-publication-preflight";
import { journalContractNoRequestProof } from "../../infrastructure/quantity-provider-preflight-recovery.repository";
import type { TerminalRequestReceipt } from "../../domain/quantity-provider-terminal-response";

describe("eBay preflight evidence contracts", () => {
  it("binds the original mutation without retaining its body and isolates concurrent protocol owners", async () => {
    const one = { method: "POST", path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
      body: { inventoryItemGroupKey: "GROUP-1", marketplaceId: "EBAY_US" } };
    const two = { ...one, body: { ...one.body, inventoryItemGroupKey: "GROUP-2" } };
    const records = await Promise.all([one, two].map(request => withEbayQuantityRequestJournal(request, async () => {
      await Promise.resolve();
      return currentEbayQuantityRequestJournal();
    })));
    expect(records).toEqual([one, two].map(request => ({ version: 1, provider: "ebay", method: "POST", path: request.path,
      requestHash: preflightEvidenceHash(request.body) })));
    expect(currentEbayQuantityRequestJournal()).toBeNull();
    expect(one.body.inventoryItemGroupKey).toBe("GROUP-1");
  });

  it.each([
    { method: "GET", path: "/sell/inventory/v1/offer?sku=A" },
    { method: "POST", path: "/other/provider" },
    { method: "POST", path: "/sell/inventory/v1/offer?token=secret" },
  ])("does not declare unsupported transport coverage: %j", async request => {
    const work = vi.fn(async () => undefined);
    expect(() => withEbayQuantityRequestJournal(request, work)).toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  it("retains the original owner fence through nested protocol calls and propagates lost ownership", async () => {
    const request = { method: "POST", path: "/sell/inventory/v1/offer/publish_by_inventory_item_group", body: { group: "A" } };
    const contract = { version: 1 as const, provider: "ebay" as const, method: "POST" as const, path: request.path,
      requestHash: preflightEvidenceHash(request.body) };
    const failure = new Error("Original channel connection was lost");
    const owner = vi.fn(async () => { throw failure; });
    await expect(withEbayQuantityRequestJournalContract(contract,
      () => withEbayQuantityRequestJournal(request, () => assertCurrentEbayQuantityRequestOwner()), owner)).rejects.toBe(failure);
    expect(owner).toHaveBeenCalledOnce();
    await expect(assertCurrentEbayQuantityRequestOwner()).resolves.toBeUndefined();
    expect(owner).toHaveBeenCalledOnce();
  });

  it("does not infer old or malformed callback coverage from its provider name", () => {
    expect(journalContractNoRequestProof({ id: "1", before_record: { scope: { providerKey: "ebay" } } })).toBeNull();
    const request_journal_contract = { version: 1, provider: "ebay", method: "POST",
      path: "/sell/inventory/v1/offer/1/publish", requestHash: "a".repeat(64) };
    expect(journalContractNoRequestProof({ id: "1", before_record: { scope: { providerKey: "shopify" }, request_journal_contract } })).toBeNull();
    expect(journalContractNoRequestProof({ id: "1", before_record: { scope: { providerKey: "ebay" }, request_journal_contract: {
      ...request_journal_contract, version: 2,
    } } })).toBeNull();
  });

  it("excludes only completed explicit nonpublication intent with a complete final journal", () => {
    const path = "/sell/inventory/v1/bulk_update_price_quantity";
    const contract = { version: 1, provider: "ebay", method: "POST", path, requestHash: "a".repeat(64) };
    const input = { state: "succeeded", journalContract: contract, canonicalOutboxStock: false };
    const receipt: TerminalRequestReceipt = { requestId: "1", ordinal: 1, method: "POST", path,
      requestHash: "a".repeat(64), outcome: "completed", httpStatus: 200, responseHash: "b".repeat(64),
      errorCodes: [], recordedAt: "2026-10-17T12:00:00.000Z", requestTerminated: true };
    expect(isCompletedEbayNonPublicationAttempt(input, [receipt])).toBe(true);
    expect(isCompletedEbayNonPublicationAttempt({ ...input, journalContract: null, canonicalOutboxStock: true }, [receipt])).toBe(true);
    for (const state of ["running", "uncertain", "superseded_unknown"]) {
      expect(isCompletedEbayNonPublicationAttempt({ ...input, state }, [receipt])).toBe(false);
    }
    expect(isCompletedEbayNonPublicationAttempt(input, [])).toBe(false);
    expect(isCompletedEbayNonPublicationAttempt({ ...input, state: "not_sent" }, [])).toBe(true);
    expect(isCompletedEbayNonPublicationAttempt({ ...input, journalContract: null }, [receipt])).toBe(false);
    expect(isCompletedEbayNonPublicationAttempt(input, [{ ...receipt, outcome: null, responseHash: null }])).toBe(false);
    expect(isCompletedEbayNonPublicationAttempt(input, [{ ...receipt, requestTerminated: null }])).toBe(false);
    const publication = { ...contract, path: "/sell/inventory/v1/offer/publish_by_inventory_item_group" };
    expect(isCompletedEbayNonPublicationAttempt({ ...input, journalContract: publication }, [receipt])).toBe(false);
    expect(isCompletedEbayNonPublicationAttempt({ ...input, journalContract: publication, canonicalOutboxStock: true, state: "not_sent" }, [])).toBe(false);
    expect(isCompletedEbayNonPublicationAttempt(input, [{ ...receipt, path: publication.path, outcome: "rejected", httpStatus: 400 }])).toBe(false);
    for (const path of ["/sell/inventory/v1/inventory_item/SKU", "/sell/inventory/v1/offer/offer-1", "/sell/inventory/v1/inventory_item_group/GROUP"]) {
      expect(isCompletedEbayNonPublicationAttempt({ ...input, journalContract: { ...contract, method: "PUT", path } },
        [{ ...receipt, method: "PUT", path }])).toBe(true);
    }
  });

  it("proves completed publication preparations only from the exact versioned publish intent and every final receipt", () => {
    const contract = { version: 1, provider: "ebay", method: "POST",
      path: "/sell/inventory/v1/offer/publish_by_inventory_item_group", requestHash: "a".repeat(64) };
    const expected = { path: contract.path, requestHash: contract.requestHash };
    const receipt: TerminalRequestReceipt = { requestId: "1", ordinal: 1, method: "POST",
      path: "/sell/inventory/v1/bulk_update_price_quantity", requestHash: "c".repeat(64), outcome: "completed",
      httpStatus: 200, responseHash: "b".repeat(64), errorCodes: [], recordedAt: "2026-10-17T12:00:00.000Z", requestTerminated: true };
    expect(terminalEbayPublicationPreparationEvidence(contract, expected, [receipt])).toMatchObject({ contract, terminal: { receipts: [receipt] } });
    expect(terminalEbayPublicationPreparationEvidence(null, expected, [receipt])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence({ ...contract, version: 2 }, expected, [receipt])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence({ ...contract, requestHash: "d".repeat(64) }, expected, [receipt])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence(contract, expected, [])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence(contract, expected, [{ ...receipt, requestTerminated: null }])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence(contract, expected, [receipt, { ...receipt, requestId: "2", ordinal: 2,
      outcome: "uncertain", httpStatus: null, responseHash: null, requestTerminated: null }])).toBeNull();
    expect(terminalEbayPublicationPreparationEvidence(contract, expected, [{ ...receipt, path: contract.path,
      outcome: "rejected", httpStatus: 400 }])).toBeNull();
  });

  const proof = { jobId: "a431361e-5bf5-4249-9b17-bf3dc860a980", revision: "1", stageEventId: "101",
    stageStartedAt: "2026-10-17T12:00:00.000Z", failureEventId: "102", failureAt: "2026-10-17T12:00:01.000Z",
    groupKey: "GROUP", marketplaceId: "EBAY_US", memberSkus: ["GROUP-C500", "GROUP-P10"],
    failedRequest: { method: "GET", path: "/sell/inventory/v1/offer?sku=GROUP-C500&marketplace_id=EBAY_US",
      httpStatus: 500, errorCodes: ["25001"] }, sourceEvidenceHash: "a".repeat(64) };
  it("accepts only the known legacy first-member lookup failure in one ordered stage", () => {
    expect(legacyEbayPublicationPreflightProofSchema.parse(proof)).toEqual(proof);
    for (const invalid of [
      { ...proof, memberSkus: [...proof.memberSkus].reverse() },
      { ...proof, memberSkus: [proof.memberSkus[0], proof.memberSkus[0]] },
      { ...proof, failureEventId: "100" },
      { ...proof, failureAt: "2026-10-17T11:59:59.000Z" },
      { ...proof, failedRequest: { ...proof.failedRequest, method: "POST" } },
      { ...proof, failedRequest: { ...proof.failedRequest, httpStatus: 408 } },
      { ...proof, failedRequest: { ...proof.failedRequest, errorCodes: ["25007"] } },
      { ...proof, failedRequest: { ...proof.failedRequest, path: proof.failedRequest.path.replace("C500", "P10") } },
    ]) expect(legacyEbayPublicationPreflightProofSchema.safeParse(invalid).success).toBe(false);
  });
});
