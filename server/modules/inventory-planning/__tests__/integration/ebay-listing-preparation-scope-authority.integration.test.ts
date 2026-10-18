import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import { readEbayListingPreparationScope, type VerifiedEbayListingPreparation } from "../../../channels/ebay-listing-preparation-scope";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { WALMART_INVENTORY_NOW as now } from "../fixtures/walmart-publication-inventory.fixture";
import { createEbayListingScopeObservation, ebayListingScopeSku, ebayListingScopeSource, installEbayListingScopeFixture } from "../fixtures/ebay-listing-preparation-scope.fixture";
import { ensureEbayPublicationReady, withEbayPublicationReadinessApplied } from "../../infrastructure/ebay-publication-readiness.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;

dbDescribe.sequential("verified listing preparation scope authority through PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live HTTP is prohibited in the disposable scope-authority suite."); }));
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayListingScopeFixture(database.pool);
  }, 30_000);
  afterEach(async () => { await database?.close(); vi.unstubAllGlobals(); });

  const prepare = (verifiedListing: VerifiedEbayListingPreparation, source: InventoryEbayPublicationReadinessInput = ebayListingScopeSource(), commandKey = randomUUID()) =>
    ensureEbayPublicationReady(database.pool, source, { commandKey, actor: "authority-test", now, verifiedListing });

  async function proofFixture() {
    const fixture = await createEbayListingScopeObservation(database.pool);
    const observed = await fixture.observe();
    return { ...fixture, proof: { sourceIdentity: fixture.source, observation: observed.observation } satisfies VerifiedEbayListingPreparation };
  }

  async function publicationState() {
    // These are constants in an isolated database, not request-controlled SQL.
    const tables = ["inventory.publication_variant_mapping_heads", "inventory.publication_variant_mapping_versions",
      "inventory.publication_mapping_preparations", "inventory.ebay_publication_readiness_applications",
      "inventory.inventory_publication_outbox", "inventory.quantity_publication_attempts",
      "channels.ebay_listing_sync_jobs", "public.audit_events"] as const;
    return Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await database.pool.query(`SELECT to_jsonb(entry) AS value FROM ${table} entry ORDER BY to_jsonb(entry)::text`)).rows,
    ])));
  }

  it.each(["environment", "account", "requested members"] as const)(
    "rejects a valid provider proof used for a different %s before writing preparation", async mismatch => {
      const { proof } = await proofFixture();
      const requested = ebayListingScopeSource();
      if (mismatch === "environment") {
        // Keep the observation internally consistent so namespace validation
        // alone cannot stand in for matching the requested production target.
        const sandbox = <T extends { identityNamespace: string }>(identity: T): T =>
          ({ ...identity, identityNamespace: identity.identityNamespace.replace("ebay:production:", "ebay:sandbox:") });
        proof.observation = { ...proof.observation,
          providerAccount: { ...proof.observation.providerAccount, accountNamespace: "sandbox" },
          listingIdentity: sandbox(proof.observation.listingIdentity),
          publicationKeyIdentity: proof.observation.publicationKeyIdentity ? sandbox(proof.observation.publicationKeyIdentity) : null,
          members: proof.observation.members.map(member => ({ ...member,
            offerIdentity: member.offerIdentity ? sandbox(member.offerIdentity) : null,
            inventoryItemIdentity: member.inventoryItemIdentity ? sandbox(member.inventoryItemIdentity) : null,
          })),
        };
      }
      if (mismatch === "account") requested.accountId = "another-seller";
      if (mismatch === "requested members") requested.variants = requested.variants.slice(0, 1);
      const before = await publicationState();
      await expect(prepare(proof, requested)).rejects.toMatchObject({ code: "EBAY_SYNC_PREPARATION_SCOPE_CHANGED" });
      expect(await publicationState()).toEqual(before);
    });

  it("rejects a source proof that omits an actual saved retired member", async () => {
    const { proof } = await proofFixture();
    proof.sourceIdentity = { ...proof.sourceIdentity, variants: proof.sourceIdentity.variants.filter(member => member.variantId !== 103) };
    proof.observation = { ...proof.observation, evidence: { ...proof.observation.evidence, nonMemberCandidates: [] } };
    const before = await publicationState();
    await expect(prepare(proof)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(await publicationState()).toEqual(before);
  });

  it.each([false, true])("rejects an excluded offer identity changed after observation (receipt already applied: %s)", async applied => {
    const { proof } = await proofFixture(), commandKey = randomUUID();
    if (applied) await prepare(proof, ebayListingScopeSource(), commandKey);
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='changed-offer' WHERE channel_id=67 AND product_variant_id=103");
    const before = await publicationState();
    await expect(prepare(proof, ebayListingScopeSource(), commandKey)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(await publicationState()).toEqual(before);
  });

  it("rejects an excluded member that becomes selected after its observation", async () => {
    const { proof } = await proofFixture();
    await database.pool.query("UPDATE catalog.product_variants SET is_active=true WHERE id=103");
    const before = await publicationState();
    await expect(prepare(proof)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
    expect(await publicationState()).toEqual(before);
  });

  it("revalidates membership evidence even when a preparation receipt already exists", async () => {
    const { proof } = await proofFixture(), commandKey = randomUUID();
    await prepare(proof, ebayListingScopeSource(), commandKey);
    const tampered = { ...proof, observation: { ...proof.observation, evidence: { ...proof.observation.evidence, nonMemberCandidates: [] } } };
    const before = await publicationState();
    await expect(prepare(tampered, ebayListingScopeSource(), commandKey)).rejects.toMatchObject({ code: "EBAY_SYNC_MEMBERSHIP_CHANGED" });
    expect(await publicationState()).toEqual(before);
  });

  it("rejects tampered proof on direct receipt replay before invoking its transactional follow-up", async () => {
    const { proof } = await proofFixture(), commandKey = randomUUID();
    await prepare(proof, ebayListingScopeSource(), commandKey);
    const saved = (await database.pool.query<{ receipt: { reviewHash: string; contextHash: string } }>(
      "SELECT receipt FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].receipt;
    const tampered = { ...proof, observation: { ...proof.observation, evidence: { ...proof.observation.evidence, nonMemberCandidates: [] } } };
    const followUp = vi.fn(async () => undefined), before = await publicationState();
    await expect(withEbayPublicationReadinessApplied(database.pool, { source: ebayListingScopeSource(), commandKey,
      expectedReviewHash: saved.reviewHash, contextHash: saved.contextHash }, "authority-test", now, followUp, undefined, tampered))
      .rejects.toMatchObject({ code: "EBAY_SYNC_MEMBERSHIP_CHANGED" });
    expect(followUp).not.toHaveBeenCalled();
    expect(await publicationState()).toEqual(before);
  });

  it("does not downgrade a scoped receipt to a proof-free transactional follow-up", async () => {
    const { proof } = await proofFixture(), commandKey = randomUUID();
    await prepare(proof, ebayListingScopeSource(), commandKey);
    const saved = (await database.pool.query<{ receipt: { reviewHash: string; contextHash: string } }>(
      "SELECT receipt FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].receipt;
    const followUp = vi.fn(async () => undefined), before = await publicationState();
    await expect(withEbayPublicationReadinessApplied(database.pool, { source: ebayListingScopeSource(), commandKey,
      expectedReviewHash: saved.reviewHash, contextHash: saved.contextHash }, "authority-test", now, followUp))
      .rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT" });
    expect(followUp).not.toHaveBeenCalled();
    expect(await publicationState()).toEqual(before);
  });

  it.each(["all observed members", "excluded already mapped"] as const)(
    "replays a pre-scope receipt without rewriting it when the current proof has %s", async scenario => {
      if (scenario === "all observed members") {
        await database.pool.query("DELETE FROM channels.channel_listings WHERE channel_id=67 AND product_variant_id=103");
      } else {
        await ensureEbayPublicationReady(database.pool,
          { ...ebayListingScopeSource(), variants: [...ebayListingScopeSource().variants, { productVariantId: 103, sku: ebayListingScopeSku("C200") }] },
          { commandKey: randomUUID(), actor: "authority-test", now });
      }
      const commandKey = randomUUID();
      await ensureEbayPublicationReady(database.pool, ebayListingScopeSource(), { commandKey, actor: "authority-test", now });
      const before = await publicationState(), { proof } = await proofFixture();
      await prepare(proof, ebayListingScopeSource(), commandKey);
      expect(await publicationState()).toEqual(before);
    });

  it("fences new same-product members until the verified source transaction finishes", async () => {
    const { proof } = await proofFixture(), reader = await database.pool.connect(), writer = await database.pool.connect();
    try {
      await reader.query("BEGIN");
      await readEbayListingPreparationScope(reader, ebayListingScopeSource(), proof, true);
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='100ms'");
      await expect(writer.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(106,20,'NEW-SAVED-MEMBER')"))
        .rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK");
      await reader.query("COMMIT");
      await writer.query("BEGIN");
      await writer.query("INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(106,20,'NEW-SAVED-MEMBER')");
      await writer.query(`INSERT INTO channels.channel_listings(id,channel_id,product_variant_id,external_sku,external_variant_id,sync_status)
        VALUES(4,67,106,'NEW-SAVED-MEMBER','offer-new','synced')`);
      await writer.query("COMMIT");
      const before = await publicationState();
      await expect(prepare(proof)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
      expect(await publicationState()).toEqual(before);
    } finally {
      await reader.query("ROLLBACK"); await writer.query("ROLLBACK"); reader.release(); writer.release();
    }
  });

  it("concurrently replays equivalent fresh observations under one command and one immutable receipt", async () => {
    const fixture = await proofFixture(), commandKey = randomUUID();
    fixture.setObservedAt(new Date(now.getTime() + 30_000));
    const fresh = await fixture.observe();
    expect(fresh.observation.observedAt).not.toEqual(fixture.proof.observation.observedAt);
    await Promise.all([
      prepare(fixture.proof, ebayListingScopeSource(), commandKey),
      prepare({ sourceIdentity: fixture.source, observation: fresh.observation }, ebayListingScopeSource(), commandKey),
    ]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.ebay_publication_readiness_applications WHERE command_key=$1", [commandKey])).rows[0].n).toBe(1);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.publication_mapping_preparations WHERE idempotency_key=$1", [`ebay-stock:${commandKey}`])).rows[0].n).toBe(1);
    const after = await publicationState();
    fixture.setObservedAt(new Date(now.getTime() + 60_000));
    await prepare({ sourceIdentity: fixture.source, observation: (await fixture.observe()).observation }, ebayListingScopeSource(), commandKey);
    expect(await publicationState()).toEqual(after);
  });
});
