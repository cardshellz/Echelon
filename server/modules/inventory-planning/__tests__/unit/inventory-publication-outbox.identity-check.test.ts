import { describe, expect, it, vi } from "vitest";

import {
  PUBLICATION_IDENTITY_RETIRED,
  PostgresInventoryPublicationOutboxRepository,
  type ClaimedInventoryPublication,
} from "../../infrastructure/inventory-publication-outbox.repository";

// Channels PR2 (PLAN-CH2 v4.1 §4.8 N5, SAF-1): under the pair lock, after the lease and newer-revision checks and
// before the provider call, a full claim whose item is no longer the pair's sealed link is superseded with
// PUBLICATION_IDENTITY_RETIRED and nothing is sent. No head keeps today's behaviour. The real-database proof is
// PG 19 (stock-link.integration.test.ts); this pins the order, the comparison and the log line.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const NOW = new Date("2026-10-27T12:00:00.000Z");
type Head = { active_mapping_id: number | null; external_inventory_item_id: string | null } | null;

function harness(head: Head, claimOverrides: Partial<ClaimedInventoryPublication> = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const client = {
    queries,
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("AS newer_exists")) return { rows: [{ state: "leased", lease_token: "lease-runtime", newer_exists: false }] };
      if (sql.includes("FROM inventory.publication_variant_mapping_heads AS head")) return { rows: head === null ? [] : [head] };
      if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
      if (sql.includes("UPDATE inventory.inventory_publication_outbox")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const log = { error: vi.fn(), debug: vi.fn() };
  const repository = new PostgresInventoryPublicationOutboxRepository({ connect: vi.fn(async () => client) } as never, log);
  const claim: ClaimedInventoryPublication = {
    outboxId: "41", activationRunId: "12", publicationPhase: "full", publicationTargetId: 9, publicationTargetRevision: "4",
    productVariantId: 101, desiredRevision: "2", desiredQuantity: "7", channelId: 35, destinationKind: "channel_connection",
    channelConnectionId: 7, dropshipStoreConnectionId: null, providerKey: "shopify", providerScopeType: "location",
    externalScopeId: "98765", externalInventoryItemId: "222", externalSku: "P5", leaseToken: "lease-runtime",
    attemptNumber: 1, attemptStartedAt: NOW, ...claimOverrides,
  };
  return { client, log, repository, claim };
}

const identityQuery = (client: ReturnType<typeof harness>["client"]) =>
  client.queries.find(({ sql }) => sql.includes("FROM inventory.publication_variant_mapping_heads AS head"));

describe("outbox worker identity check before every provider write (N5)", () => {
  it("keeps today's behaviour when the pair has no head", async () => {
    const { client, repository, claim } = harness(null);
    const work = vi.fn(async () => "sent");
    await expect(repository.runIfCurrent(claim, work)).resolves.toEqual({ status: "current", value: "sent" });
    expect(work).toHaveBeenCalledOnce();
    expect(identityQuery(client)?.values).toEqual([9, 101]);
  });

  it("sends when the pair's sealed link names the claim's item, compared trimmed like the planner", async () => {
    for (const item of ["222", " 222 "]) {
      const { repository, claim, log } = harness({ active_mapping_id: 5, external_inventory_item_id: item });
      const work = vi.fn(async () => "sent");
      await expect(repository.runIfCurrent(claim, work)).resolves.toEqual({ status: "current", value: "sent" });
      expect(work).toHaveBeenCalledOnce();
      expect(log.debug).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "the head has no sealed active link (retired)", head: { active_mapping_id: null, external_inventory_item_id: null } },
    { label: "the head's sealed link names another item (relinked)", head: { active_mapping_id: 6, external_inventory_item_id: "333" } },
  ])("supersedes with PUBLICATION_IDENTITY_RETIRED and makes no provider call when $label", async ({ head }) => {
    const { client, repository, claim, log } = harness(head);
    const work = vi.fn();
    await expect(repository.runIfCurrent(claim, work)).resolves.toEqual({ status: "superseded" });
    expect(work).not.toHaveBeenCalled();
    const sql = client.queries.map(entry => entry.sql);
    // Under the pair lock, after the lease check, before the verified-withdrawal supersede (no SERIALIZABLE begin).
    expect(sql.findIndex(text => text.includes("pg_advisory_lock"))).toBe(0);
    expect(sql.findIndex(text => text.includes("AS newer_exists")))
      .toBeLessThan(sql.findIndex(text => text.includes("FROM inventory.publication_variant_mapping_heads AS head")));
    expect(sql).not.toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const attempt = client.queries.find(entry => entry.sql.includes("inventory_publication_attempts"));
    expect(attempt?.values).toEqual(expect.arrayContaining([PUBLICATION_IDENTITY_RETIRED,
      "This store item is no longer the size's linked item; no provider request was made."]));
    const transition = client.queries.find(entry => entry.sql.includes("UPDATE inventory.inventory_publication_outbox"));
    expect(transition?.values).toEqual(["41", "lease-runtime", PUBLICATION_IDENTITY_RETIRED,
      "This store item is no longer the size's linked item; no provider request was made."]);
    expect(sql.at(-1)).toContain("pg_advisory_unlock");
    // Expected and terminal: DEBUG with the correlation ids, never ERROR.
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledExactlyOnceWith("inventory_publication.outbox.identity_retired", expect.objectContaining({
      outcome: "superseded", error_code: PUBLICATION_IDENTITY_RETIRED, outbox_id: "41", publication_target_id: 9,
      product_variant_id: 101, provider_key: "shopify",
      before: { state: "leased", external_inventory_item_id: "222" },
      after: { state: "superseded", active_mapping_id: head.active_mapping_id, active_external_inventory_item_id: head.external_inventory_item_id },
    }));
  });

  it("does not check a conservative claim: an activation's heads may hold only a draft", async () => {
    const { client, repository, claim } = harness({ active_mapping_id: null, external_inventory_item_id: null }, { publicationPhase: "conservative" });
    const work = vi.fn(async () => "sent");
    await expect(repository.runIfCurrent(claim, work)).resolves.toEqual({ status: "current", value: "sent" });
    expect(identityQuery(client)).toBeUndefined();
  });

  it("supersedes a newer-revision claim before reading the identity (unchanged order and reason)", async () => {
    const { client, repository, claim } = harness({ active_mapping_id: null, external_inventory_item_id: null });
    client.query.mockImplementation(async (sql: string, values?: readonly unknown[]) => {
      client.queries.push({ sql, values });
      if (sql.includes("AS newer_exists")) return { rows: [{ state: "leased", lease_token: "lease-runtime", newer_exists: true }] };
      if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
      return { rows: [], rowCount: 1 };
    });
    await expect(repository.runIfCurrent(claim, vi.fn())).resolves.toEqual({ status: "superseded" });
    expect(identityQuery(client)).toBeUndefined();
    expect(client.queries.some(({ values }) => values?.includes("SUPERSEDED_BEFORE_PROVIDER_WRITE"))).toBe(true);
  });

  it("accepts a dead-letter-only logger (debug is optional)", async () => {
    const { client, claim } = harness({ active_mapping_id: null, external_inventory_item_id: null });
    const repository = new PostgresInventoryPublicationOutboxRepository({ connect: vi.fn(async () => client) } as never, { error: vi.fn() });
    await expect(repository.runIfCurrent(claim, vi.fn())).resolves.toEqual({ status: "superseded" });
  });
});
