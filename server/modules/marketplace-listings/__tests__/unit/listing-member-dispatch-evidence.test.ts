import { describe, expect, it } from "vitest";
import { assessListingMemberDispatchHistory, type ListingMemberDispatchHead } from "../../domain/listing-member-dispatch-evidence";

const operationId = "9f609d01-39a6-4e20-abfc-668c3745b4e4";
const firstKey = "c393026b-624e-4702-ad2c-152f4eb8c227";
const secondKey = "61b24641-674c-4373-9d24-5c954191a204";
const head: ListingMemberDispatchHead = {
  id: operationId, version: 1, identityKey: "identity", identity: { sku: "remote" }, sourceIdentity: { sku: "remote" },
  sourceRevision: "revision", productId: 1, productVariantId: 2, state: "pending", code: null,
  dispatchStatus: "none", dispatchKey: null, dispatchFinality: null,
};
function event(version: number, state: string, status: string, key: string | null, finality: string | null = null) {
  return { version, afterState: { id: head.id, version, identity_key: head.identityKey, identity: head.identity,
    source_identity: head.sourceIdentity, source_revision: head.sourceRevision, product_id: head.productId,
    product_variant_id: head.productVariantId, state, code: null, dispatch_status: status, dispatch_key: key,
    dispatch_finality: finality } };
}

describe("listing member dispatch history", () => {
  it("accepts an uninterrupted history with no send marker", () => {
    expect(assessListingMemberDispatchHistory(head, [event(1, "pending", "none", null)]))
      .toEqual({ unconfirmed: false, hadRetiringEvent: false });
  });
  it("closes a dispatch only with terminal evidence for that same key", () => {
    const events = [event(1, "pending", "none", null), event(2, "retiring", "unknown", firstKey),
      event(3, "retiring", "accepted", firstKey, "terminal")];
    expect(assessListingMemberDispatchHistory({ ...head, version: 3, state: "retiring", dispatchStatus: "accepted", dispatchKey: firstKey, dispatchFinality: "terminal" }, events))
      .toEqual({ unconfirmed: false, hadRetiringEvent: true });
    events[2] = event(3, "retiring", "accepted", secondKey, "terminal");
    expect(assessListingMemberDispatchHistory({ ...head, version: 3, state: "retiring", dispatchStatus: "accepted", dispatchKey: secondKey, dispatchFinality: "terminal" }, events).unconfirmed)
      .toBe(true);
  });
  it.each([null, "pending"])("does not treat %s acceptance as a final receipt", finality => {
    const events = [event(1, "pending", "none", null), event(2, "retiring", "unknown", firstKey),
      event(3, "retired", "accepted", firstKey, finality)];
    expect(assessListingMemberDispatchHistory({ ...head, version: 3, state: "retired", dispatchStatus: "accepted",
      dispatchKey: firstKey, dispatchFinality: finality }, events).unconfirmed).toBe(true);
  });
  it("does not allow a later terminal receipt to settle a different pending operation", () => {
    const events = [event(1, "pending", "none", null), event(2, "retiring", "unknown", firstKey),
      event(3, "retiring", "accepted", firstKey, "pending"), event(4, "retiring", "unknown", secondKey),
      event(5, "retired", "accepted", secondKey, "terminal")];
    expect(assessListingMemberDispatchHistory({ ...head, version: 5, state: "retired", dispatchStatus: "accepted",
      dispatchKey: secondKey, dispatchFinality: "terminal" }, events).unconfirmed).toBe(true);
  });
  it("rejects terminal evidence without a matching durable send marker", () => {
    const events = [event(1, "pending", "none", null), event(2, "retired", "accepted", firstKey, "terminal")];
    expect(assessListingMemberDispatchHistory({ ...head, version: 2, state: "retired", dispatchStatus: "accepted",
      dispatchKey: firstKey, dispatchFinality: "terminal" }, events).unconfirmed).toBe(true);
  });
  it("does not infer finality from an unkeyed legacy marker", () => {
    const events = [event(1, "pending", "none", null), event(2, "retiring", "none", null), event(3, "retired", "none", null)];
    expect(assessListingMemberDispatchHistory({ ...head, version: 3, state: "retired" }, events).unconfirmed).toBe(true);
  });
  it.each(["missing", "wrong version", "wrong identity", "wrong last state"]) (
    "treats %s history as unconfirmed", (kind) => {
      const events = [event(1, "pending", "none", null), event(2, "retired", "none", null)];
      if (kind === "missing") events.pop();
      if (kind === "wrong version") events[1].version = 3;
      if (kind === "wrong identity") events[1].afterState.identity = { sku: "other" };
      const current = { ...head, version: 2, state: kind === "wrong last state" ? "failed" : "retired" };
      expect(assessListingMemberDispatchHistory(current, events).unconfirmed).toBe(true);
    },
  );
});
