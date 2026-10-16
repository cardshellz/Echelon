import { describe, expect, it, vi } from "vitest";
import { EbayPublicationContentRefreshRejectedError, EbayPublicationReconciliationService,
  type EbayReconciliationClaim, type EbayReconciliationTarget } from "../../application/ebay-publication-reconciliation.service";
import { QuantityPublicationAdmissionError } from "../../domain/quantity-publication-admission";

const NOW = new Date("2026-10-15T18:00:00Z");
const TOKEN = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-000000000002";
const claim: EbayReconciliationClaim = { watchId: "1", revision: "1", cycle: "1", leaseToken: TOKEN, attempts: 1,
  productId: 20, connectionId: 9, accountId: "seller", scopes: [] };
const target: EbayReconciliationTarget = { outboxId: "1", publicationTargetId: 3, publicationTargetRevision: "2",
  desiredRevision: "1", desiredQuantity: "17", destination: { kind: "channel_connection", channelConnectionId: 9, dropshipStoreConnectionId: null },
  channelId: 67, providerScopeType: "account", externalScopeId: "seller", productVariantId: 101, externalInventoryItemId: "P5", externalSku: "P5" };
function fixture() {
  const store = { claimDue: vi.fn().mockResolvedValueOnce([claim]).mockResolvedValue([]), renew: vi.fn().mockResolvedValue(undefined),
    plan: vi.fn().mockResolvedValue([target]), recordStock: vi.fn().mockResolvedValue({ current: true, repaired: false, checkedAt: NOW, outboxIds: ["1"] }),
    finish: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined), readStatuses: vi.fn() };
  const adapter = { supportedScopeTypes: ["account"], publishAbsolute: vi.fn(), readAbsolute: vi.fn().mockResolvedValue({ observedQuantity: 17, providerResponse: { quantity: 17 } }) };
  const content = vi.fn().mockResolvedValue({ jobId: JOB });
  const service = new EbayPublicationReconciliationService(store, { get: () => adapter as never }, content, () => NOW, () => TOKEN);
  return { store, adapter, content, service };
}
describe("durable eBay stock and content reconciliation", () => {
  it("claims just in time and finishes only after a current read and durable content handoff", async () => {
    const f = fixture();
    expect(await f.service.processDue()).toEqual({ checked: 1, repaired: 0, blocked: 0 });
    expect(f.store.claimDue).toHaveBeenCalledWith(1, NOW, TOKEN);
    expect(f.store.recordStock).toHaveBeenCalledWith(claim, [expect.objectContaining({ observedQuantity: 17, quantityConsistent: true })], NOW);
    expect(f.store.finish).toHaveBeenCalledWith(claim, expect.objectContaining({ current: true }), JOB, NOW);
    expect(f.content).toHaveBeenCalledWith(expect.objectContaining({ productId: 20, connectionId: 9, accountId: "seller" }));
  });
  it("enqueues current content even when a newer uncertain stock writer blocks its quantity check", async () => {
    const f = fixture();
    f.store.plan.mockRejectedValue(new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_BUSY", "An exact publisher is still unresolved."));
    expect(await f.service.processDue()).toEqual({ checked: 0, repaired: 0, blocked: 1 });
    expect(f.content).toHaveBeenCalledOnce();
    expect(f.store.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ commandConsumed: true, contentJobId: JOB, code: "PUBLICATION_SCOPE_BUSY" }), NOW);
    expect(f.store.finish).not.toHaveBeenCalled();
  });
  it("never follows a changed exact account or SKU into another content write", async () => {
    const f = fixture();
    f.store.plan.mockRejectedValue(new QuantityPublicationAdmissionError("PUBLICATION_RECONCILIATION_SCOPE_CHANGED", "Mapping changed."));
    expect((await f.service.processDue()).blocked).toBe(1);
    expect(f.content).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ commandConsumed: false }), NOW);
  });
  it("keeps the cycle key on uncertain content persistence and redacts unchecked diagnostics", async () => {
    const f = fixture();
    f.content.mockRejectedValue(new Error("postgres://private-token SQL secret"));
    await f.service.processDue();
    expect(f.store.fail).toHaveBeenCalledWith(claim, { commandConsumed: false, code: "PUBLICATION_RECONCILIATION_FAILED",
      message: "The saved stock check could not finish. It will retry automatically; historical request outcomes remain unknown." }, NOW);
  });
  it("advances a durably rejected content command so correction can admit a later cycle", async () => {
    const f = fixture();
    f.content.mockRejectedValue(new EbayPublicationContentRefreshRejectedError("EBAY_MAPPING_NOT_READY", "Review the listing mapping."));
    await f.service.processDue();
    expect(f.store.fail).toHaveBeenCalledWith(claim, expect.objectContaining({ commandConsumed: true, code: "EBAY_MAPPING_NOT_READY" }), NOW);
  });
  it.each(["false", null, 0])("refuses malformed quantity consistency evidence %s", async consistency => {
    const f = fixture();
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 17, quantityConsistent: consistency, providerResponse: {} });
    expect((await f.service.processDue()).blocked).toBe(1);
    expect(f.store.recordStock).not.toHaveBeenCalled();
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.content).toHaveBeenCalledOnce();
  });
  it("retains inconsistent quantities for the canonical repair owner", async () => {
    const f = fixture();
    f.adapter.readAbsolute.mockResolvedValue({ observedQuantity: 17, quantityConsistent: false, providerResponse: {} });
    f.store.recordStock.mockResolvedValue({ current: true, repaired: true, checkedAt: NOW, outboxIds: ["2"] });
    expect(await f.service.processDue()).toEqual({ checked: 1, repaired: 1, blocked: 0 });
    expect(f.store.recordStock).toHaveBeenCalledWith(claim, [expect.objectContaining({ quantityConsistent: false })], NOW);
  });
  it("continues other watches after one failed failure checkpoint", async () => {
    const f = fixture();
    f.store.claimDue.mockReset().mockResolvedValueOnce([claim]).mockResolvedValueOnce([{ ...claim, watchId: "2" }]).mockResolvedValue([]);
    f.store.plan.mockRejectedValueOnce(new Error("temporary failure"));
    f.store.fail.mockRejectedValueOnce(new Error("database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await f.service.processDue()).toEqual({ checked: 1, repaired: 0, blocked: 1 });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"watchId":"1"'));
    } finally { log.mockRestore(); }
  });
});
