import { describe, expect, it, vi } from "vitest";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationOutboxClaim } from "../../application/quantity-publication-admission.port";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";

const scope: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 7,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: "account", externalInventoryItemId: "SKU-A",
  productId: 20, productVariantId: 101 };
function fixture() {
  const connect = vi.fn(async (): Promise<never> => { throw new Error("Unexpected database access"); });
  return { connect, owner: new PostgresQuantityPublicationAdmission({ connect }) };
}

describe("non-admitting legacy catch-up expectation", () => {
  it("does not touch the database for resolver failure before an actual provider admission", async () => {
    const f = fixture(); const error = new Error("Preflight resolver failed");
    await expect(f.owner.withLegacyCatchupScope(scope, async () => { throw error; })).rejects.toBe(error);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(f.owner.withLegacyCatchupScope(scope, async () => "new context after failure")).resolves.toBe("new context after failure");
  });
  it("does not create a provider attempt merely because scoped planning resolves", async () => {
    const f = fixture(); await expect(f.owner.withLegacyCatchupScope(scope, async () => "planned only")).resolves.toBe("planned only");
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    { externalInventoryItemId: "SKU-B" }, { externalScopeId: "another-account" }, { connectionId: 8 },
    { destinationKind: "dropship_store_connection" as const }, { providerKey: "shopify" as const }, { providerScopeType: "location" as const },
  ])("rejects expansion of an exact expected provider identity before DB or I/O: %j", async changed => {
    const f = fixture(); const provider = vi.fn();
    await expect(f.owner.withLegacyCatchupScope(scope, () => f.owner.run({ ...scope, ...changed }, provider)))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    expect(f.connect).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
  it("cannot nest an expectation to replace the pending scope", async () => {
    const f = fixture(); const work = vi.fn();
    await expect(f.owner.withLegacyCatchupScope(scope, () => f.owner.withLegacyCatchupScope(scope, work)))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_NESTING_INVALID" });
    expect(f.connect).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
  });
  it("cannot expand a retry into a group, even if its first member matches", async () => {
    const f = fixture(); const plan = vi.fn(); const provider = vi.fn();
    await expect(f.owner.withLegacyCatchupScope(scope, () => f.owner.runListingGroup(scope, [scope], plan, provider)))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    expect(f.connect).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
  it("cannot inherit an outbox capability from the legacy expectation", async () => {
    const f = fixture(); const provider = vi.fn();
    const claim: QuantityPublicationOutboxClaim = { outboxId: "1", activationRunId: "1", publicationTargetId: 1,
      productVariantId: 101, desiredRevision: "1", desiredQuantity: "5", leaseToken: "lease", destinationKind: "channel_connection",
      channelConnectionId: 7, dropshipStoreConnectionId: null, providerKey: "ebay", providerScopeType: "account",
      externalScopeId: "account", externalInventoryItemId: "SKU-A", externalSku: null };
    await expect(f.owner.withLegacyCatchupScope(scope, () => f.owner.runOutbox(claim, provider)))
      .rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_SCOPE_MISMATCH" });
    expect(f.connect).not.toHaveBeenCalled(); expect(provider).not.toHaveBeenCalled();
  });
});
