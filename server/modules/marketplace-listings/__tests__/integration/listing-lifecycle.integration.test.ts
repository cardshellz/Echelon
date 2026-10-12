import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresListingLifecycleRepository } from "../../infrastructure/pg-listing-lifecycle.repository";
import { ListingLifecycleService } from "../../application/listing-lifecycle.service";
import { testAccount, testId, fixedNow } from "../fixtures/listing-publication.fixture";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import { listingAccountKey } from "../../domain/listing-publication";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(url && disposable ? describe : describe.skip).sequential("listing retirement ownership", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresListingLifecycleRepository;
  const provider = {
    account: vi.fn(async () => testAccount),
    observe: vi.fn(async (_account: ListingAccount, sku: string) => ({ sku, title: "Card sleeves", retired: false })),
    holdStock: vi.fn(async () => {}), retire: vi.fn(async () => {}),
  };
  let service: ListingLifecycleService;
  let sequence = 1;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, `CREATE SCHEMA channels; CREATE SCHEMA catalog;
      CREATE TABLE channels.channels(id integer PRIMARY KEY); CREATE TABLE catalog.product_variants(id integer PRIMARY KEY);`);
    for (const file of ["0707_channel_listing_publication.sql", "0724_channel_listing_updates.sql", "259_channel_listing_lifecycle.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    repository = new PostgresListingLifecycleRepository(database.pool);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`DROP TRIGGER IF EXISTS fail_lifecycle_audit ON marketplace.channel_listing_lifecycle_events;
      TRUNCATE channels.channels CASCADE; INSERT INTO channels.channels VALUES (104),(105);`);
    vi.clearAllMocks();
    provider.account.mockResolvedValue(testAccount);
    provider.observe.mockImplementation(async (_account, sku) => ({ sku, title: "Card sleeves", retired: false }));
    provider.retire.mockResolvedValue(); provider.holdStock.mockResolvedValue();
    sequence = 1;
    service = new ListingLifecycleService({ store: repository, provider, now: () => fixedNow, uuid: () => testId(sequence++) });
  });
  const request = (action: "unpublish" | "remove" = "unpublish", sku = "SLEEVES-100") => service.request(104, { account: testAccount, sku, action }, "operator");

  it("stops only the requested SKU in the requested account, and keeps provider writes behind the command", async () => {
    const record = await request();
    expect(record.state).toBe("pending");
    expect(provider.retire).not.toHaveBeenCalled();
    const write = vi.fn(async () => "sent");
    await expect(repository.withAllowed(testAccount, ["SLEEVES-100"], write)).rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED" });
    expect(write).not.toHaveBeenCalled();
    await expect(repository.withAllowed(testAccount, ["OTHER-SKU"], write)).resolves.toBe("sent");
    await expect(repository.withAllowed({ ...testAccount, accountId: "different-seller" }, ["SLEEVES-100"], write)).resolves.toBe("sent");
    await expect(repository.withAllowed(testAccount, [], write)).resolves.toBe("sent"); // inventory zero is still permitted
  });
  it("serializes an existing provider call with a stop request, without partial changes", async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const write = repository.withAllowed(testAccount, ["SLEEVES-100"], async () => { entered(); await wait; });
    await ready;
    try {
      await expect(request()).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_BUSY" });
      await expect(repository.withAllowed(testAccount, ["SLEEVES-100"], async () => "sent")).resolves.toBe("sent");
      await expect(request("unpublish", "OTHER-SKU")).resolves.toMatchObject({ state: "pending" });
    }
    finally { release(); await write; }
    expect((await repository.list(testAccount, ["SLEEVES-100"]))).toEqual([]);
    await request();
  });
  it("releases every acquired SKU lock when a batch conflicts with retirement", async () => {
    await repository.withListing(testAccount, "ZZZ", async () => {
      await expect(repository.withAllowed(testAccount, ["AAA", "ZZZ"], async () => {})).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_BUSY" });
      await expect(repository.withListing(testAccount, "AAA", async () => "released")).resolves.toBe("released");
    });
    await expect(repository.withAllowed(testAccount, ["ZZZ"], async () => "released")).resolves.toBe("released");
  });
  it("preserves the listing until provider retirement is observed, then hides only the remove action", async () => {
    await request("remove");
    const accepted = await service.refresh(104, "SLEEVES-100");
    expect(accepted).toMatchObject({ action: "remove", state: "retiring" });
    expect(provider.holdStock).toHaveBeenCalledWith(testAccount, "SLEEVES-100", testId(1), "operator");
    expect(provider.retire).toHaveBeenCalledTimes(1);
    await service.refresh(104, "SLEEVES-100");
    expect(provider.retire).toHaveBeenCalledTimes(1);
    provider.observe.mockResolvedValue({ sku: "SLEEVES-100", title: "Card sleeves", retired: true });
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "retired", action: "remove" });
    expect(await repository.due(new Date("2030-01-01"), 25)).toEqual([]);
  });
  it("retries a rejected request without releasing the stop or claiming the item is offline", async () => {
    await request();
    provider.retire.mockRejectedValueOnce(Object.assign(new Error("Rate limited"), { code: "WALMART_RATE_LIMITED" }));
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "failed" });
    await expect(repository.withAllowed(testAccount, ["SLEEVES-100"], async () => {})).rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED" });
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "retiring" });
  });
  it("lost responses and repeated removals retain one command and immutable history", async () => {
    const first = await request();
    expect(await request()).toEqual(first);
    const removed = await request("remove");
    expect(removed.id).toBe(first.id);
    expect(await request("unpublish")).toEqual(removed);
    const events = (await database.pool.query("SELECT actor,before_state,after_state FROM marketplace.channel_listing_lifecycle_events ORDER BY id")).rows;
    expect(events).toHaveLength(2);
    expect(events[1].after_state.action).toBe("remove");
    await expect(database.pool.query("DELETE FROM marketplace.channel_listing_lifecycle_events")).rejects.toThrow(/immutable/);
    await expect(database.pool.query("DELETE FROM marketplace.channel_listing_lifecycle")).rejects.toThrow(/immutable/);
  });
  it("rejects stale accounts and malformed inputs before persistence or external mutations", async () => {
    provider.account.mockResolvedValueOnce({ ...testAccount, accountId: "other" });
    await expect(request()).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_ACCOUNT_CHANGED" });
    await expect(service.request(104, { account: testAccount, sku: "", action: "remove" }, "operator")).rejects.toThrow();
    expect(await repository.list(testAccount, ["SLEEVES-100"])).toEqual([]);
    expect(provider.retire).not.toHaveBeenCalled();
  });
  it("rolls the stop back if its audit event cannot be committed", async () => {
    await database.pool.query(`CREATE TRIGGER fail_lifecycle_audit BEFORE INSERT ON marketplace.channel_listing_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION marketplace.guard_channel_listing_evidence()`);
    await expect(request()).rejects.toThrow(/immutable/);
    expect(await repository.list(testAccount, ["SLEEVES-100"])).toEqual([]);
  });
  it.each(["sending", "processing", "uncertain"])("waits for an earlier %s maintenance feed to finish before retirement", async state => {
    await request();
    await database.pool.query(`INSERT INTO marketplace.channel_listing_updates
      (id,channel_id,account_key,sku,review_hash,intent,state,command_key,submission_id,next_attempt_at,created_by,created_at,updated_at,expires_at)
      VALUES($1,104,$2,'SLEEVES-100',repeat('a',64),'{}',$3,$4,'old-feed',$5,'operator',$5,$5,$5::timestamptz+interval '1 hour')`,
      [testId(50), listingAccountKey(testAccount), state, testId(51), fixedNow]);
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "pending", message: expect.stringContaining("earlier Walmart submission") });
    expect(provider.retire).not.toHaveBeenCalled();
    if (state === "processing") {
      await database.pool.query("UPDATE marketplace.channel_listing_updates SET state='accepted' WHERE id=$1", [testId(50)]);
      expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "retiring" });
      expect(provider.retire).toHaveBeenCalledOnce();
    }
  });
  it.each(["submitting", "processing", "needs_reconciliation"])("waits only for this SKU's %s creation batch", async state => {
    await request();
    await database.pool.query(`INSERT INTO marketplace.channel_listing_reviews
      (id,channel_id,draft_revision,review_hash,snapshot,created_by,created_at,expires_at)
      VALUES($1,104,1,repeat('a',64),'{}','operator',$2,$2::timestamptz+interval '1 hour')`, [testId(60), fixedNow]);
    const progress = { items: [{ variantId: 3, sku: "SLEEVES-100", state: "verification_pending" }],
      batches: [{ variantIds: [3], state }] };
    await database.pool.query(`INSERT INTO marketplace.channel_listing_operations
      (id,channel_id,account_key,command_key,request_hash,review_id,state,snapshot,progress,next_attempt_at,created_by,created_at,updated_at)
      VALUES($1,104,$2,$3,repeat('a',64),$4,'processing','{}',$5,$6,'operator',$6,$6)`,
      [testId(61), listingAccountKey(testAccount), testId(62), testId(60), progress, fixedNow]);
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "pending" });
    expect(provider.retire).not.toHaveBeenCalled();
    // Item verification may remain pending after a completed feed. That is the
    // SYSTEM_PROBLEM listing the operator needs to retire, not an in-flight write.
    await database.pool.query("UPDATE marketplace.channel_listing_operations SET progress=$2 WHERE id=$1", [testId(61), {
      ...progress, batches: [{ variantIds: [3], state: "processed" }, { variantIds: [4], state: "processing" }],
    }]);
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "retiring" });
    expect(provider.retire).toHaveBeenCalledOnce();
  });
  it("rejects forged actor fields and a changed provider SKU without a stop or external mutation", async () => {
    await expect(service.request(104, { account: testAccount, sku: "SLEEVES-100", action: "remove", actor: "forged" }, "operator")).rejects.toThrow();
    provider.observe.mockResolvedValueOnce({ sku: "OTHER", title: "Wrong", retired: false });
    await expect(request()).rejects.toMatchObject({ code: "LISTING_LIFECYCLE_SKU_CHANGED" });
    expect(await repository.list(testAccount, ["SLEEVES-100"])).toEqual([]);
    expect(provider.retire).not.toHaveBeenCalled();
  });
  it("counts failed worker attempts and keeps the stop when the account changes", async () => {
    await request();
    provider.account.mockResolvedValue({ ...testAccount, accountId: "different-seller" });
    expect(await service.processDue()).toEqual({ processed: 0, failed: 1 });
    expect(provider.holdStock).not.toHaveBeenCalled(); expect(provider.retire).not.toHaveBeenCalled();
    expect((await repository.list(testAccount, ["SLEEVES-100"]))[0]).toMatchObject({ state: "failed" });
  });
  it("retains the account-wide stop across a second channel and credential revision", async () => {
    await request();
    await expect(repository.withAllowed({ ...testAccount, channelId: 105, connectionId: 999, revision: 2 }, ["SLEEVES-100"], async () => {}))
      .rejects.toMatchObject({ code: "LISTING_PUBLICATION_STOPPED" });
    provider.account.mockResolvedValue({ ...testAccount, revision: 2 });
    expect(await service.refresh(104, "SLEEVES-100")).toMatchObject({ state: "retiring" });
    expect(provider.retire).toHaveBeenCalledWith({ ...testAccount, revision: 2 }, "SLEEVES-100", testId(1));
  });
  it("pages retained listings independently of Walmart's current catalog and keeps exact search account-scoped", async () => {
    for (let index = 0; index < 101; index++) await request("unpublish", `SAVED-${String(index).padStart(3, "0")}`);
    const first = await service.history(104, {});
    expect(first.items).toHaveLength(100); expect(first.nextSku).toBe("SAVED-099");
    const second = await service.history(104, { afterSku: first.nextSku });
    expect(second.items.map(item => item.sku)).toEqual(["SAVED-100"]); expect(second.nextSku).toBeNull();
    expect((await service.history(104, { sku: "SAVED-004" })).items.map(item => item.sku)).toEqual(["SAVED-004"]);
    expect((await service.history(104, { sku: "SAVED-999" })).items).toEqual([]);
    provider.account.mockResolvedValue({ ...testAccount, accountId: "another-seller" });
    expect((await service.history(104, {})).items).toEqual([]);
  });
});
