import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { ListingMemberIdentity } from "@shared/types/listing-member-lifecycle";
import { listingMemberRemoteKey, tryLockListingMemberRemote } from "../../listing-member-lifecycle";
import { PostgresListingMemberLifecycleRepository } from "../../infrastructure/pg-listing-member-lifecycle.repository";
import { decideListingEndClaim } from "../../../dropship/domain/listing-end-claims";

/**
 * The remote-member lock, published for Dropship's listing end worker (PR C, PLAN-C v4.1 §5.5, §5.8; DC8): one
 * namespace, keyed by the remote member, taken by retirement's withMember and by the end worker, so the two never
 * remove one eBay member at once. The namespace stays private to the repository.
 */
const RETIREMENT_NAMESPACE = 2591013;

function recordingClient(locked: boolean): Pick<PoolClient, "query"> & { queries: Array<{ text: string; values: unknown[] }> } {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  // A recording fake of the pg client (only `query` is used).
  return { queries, query: query as unknown as PoolClient["query"] };
}

/** The retirement view's Dropship identity of a listing (migration 900000013000018480001 :88-92), as its SQL builds it. */
function viewIdentity(): ListingMemberIdentity {
  return { destinationKind: "dropship_store_connection", connectionId: 22, channelId: null, vendorId: 10, provider: "ebay",
    accountId: "seller-22", environment: "production", market: "EBAY_US", productId: 20, productVariantId: 101, externalSku: "CS-TOP-101",
    externalProductId: "110000000101", externalVariantId: "OFFER-101", externalInventoryItemId: null, identityConflict: false };
}

describe("tryLockListingMemberRemote", () => {
  it("tries the retirement namespace with the remote key, without waiting, until the caller's transaction ends", async () => {
    const client = recordingClient(true);
    expect(await tryLockListingMemberRemote(client, viewIdentity())).toBe(true);
    expect(client.queries).toEqual([{ text: "SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked",
      values: [RETIREMENT_NAMESPACE, listingMemberRemoteKey(viewIdentity())] }]);
    expect(await tryLockListingMemberRemote(recordingClient(false), viewIdentity())).toBe(false);
  });

  it("refuses an identity that is not a listing member identity", async () => {
    await expect(tryLockListingMemberRemote(recordingClient(true), { ...viewIdentity(), provider: "" } as ListingMemberIdentity)).rejects.toThrow();
  });

  it("is what retirement's withMember takes: one try-lock, of this namespace, in its transaction", async () => {
    const client = recordingClient(false);
    const row = { id: "00000000-0000-4000-8000-000000000001", identity: viewIdentity(), source_identity: viewIdentity(),
      source_revision: "r1", state: "pending", code: null, message: null, verified_at: null, version: 1, dispatch_status: "none",
      dispatch_key: null, verification_attempts: 0, recovery_required: false };
    const pooled = { ...client, query: async (text: string, values: unknown[] = []) => {
      if (text.startsWith("SELECT * FROM marketplace.listing_member_retirements")) return { rows: [row], rowCount: 1 };
      return client.query(text, values);
    }, release: () => undefined };
    const repository = new PostgresListingMemberLifecycleRepository({ connect: async () => pooled as never });
    expect(await repository.withMember(row.id, async () => "worked")).toBeNull();
    expect(client.queries.filter((query) => query.text.includes("advisory"))).toEqual([{
      text: "SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked", values: [RETIREMENT_NAMESPACE, listingMemberRemoteKey(viewIdentity())] }]);
    // The namespace has one owner: the repository's private constant, used only through the export.
    const source = readFileSync(resolve(process.cwd(), "server/modules/marketplace-listings/infrastructure/pg-listing-member-lifecycle.repository.ts"), "utf8");
    expect(source.match(/pg_try_advisory_xact_lock/g)).toHaveLength(1);
    expect(source.match(/tryLockListingMemberRemote\(client, current\.identity\)/g)).toHaveLength(1);
  });

  it("gives the identity Dropship's claim resolves the same remote key as the view's row of the same member", () => {
    const decided = decideListingEndClaim({
      archived: false, reason: "size_removed", ids: { vendorId: 10, storeConnectionId: 22, productId: 20, productVariantId: 101 }, rePicked: false,
      listing: { status: "active", marketplaceEndedAt: null, externalOfferId: "OFFER-101", externalListingId: "110000000101", marketplaceIssueCodes: [] },
      pushProcessing: false, unsettledPushAttempt: false, staleRecoveredItem: false,
      store: { platform: "ebay", status: "connected", externalAccountId: "seller-22", externalAccountVerifiedAt: new Date(), providerEnvironment: null },
      intent: { sku: "CS-TOP-101", marketplaceId: "EBAY_US" },
      requested: { externalListingId: "110000000101", externalOfferId: "OFFER-101", externalAccountId: "seller-22", providerEnvironment: null },
      sharedWith: null,
    });
    if (decided.outcome !== "ending") throw new Error("expected the claim to start the end");
    expect(decided.resolvedIdentity).toEqual(viewIdentity());
    expect(listingMemberRemoteKey(decided.resolvedIdentity)).toBe(listingMemberRemoteKey(viewIdentity()));
    // Another local connection addressing the same remote offer shares the lock.
    expect(listingMemberRemoteKey({ ...viewIdentity(), connectionId: 99, vendorId: 11 })).toBe(listingMemberRemoteKey(viewIdentity()));
    expect(listingMemberRemoteKey({ ...viewIdentity(), externalVariantId: "OFFER-OTHER" })).not.toBe(listingMemberRemoteKey(viewIdentity()));
  });
});
