import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { InventoryPublicationTargetResumeService } from "../../application/inventory-publication-target-resume.service";
import { PostgresInventoryPublicationTargetResumeStore } from "../../infrastructure/inventory-publication-target-resume.repository";
import {
  cutoverCompositionBaseSql,
  cutoverCompositionChannelSeedSql,
  cutoverCompositionSeedSql,
  installCutoverCompositionMigrations,
} from "../fixtures/inventory-cutover-composition-database.fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-09-14T12:00:00.000Z");
const HASH = "a".repeat(64);

const fixtureSql = `
CREATE SCHEMA inventory;
CREATE SCHEMA channels;
CREATE SCHEMA catalog;
CREATE SCHEMA dropship;

CREATE TABLE inventory.availability_activation_runs (
  id bigint PRIMARY KEY,
  mode varchar(20) NOT NULL,
  state varchar(20) NOT NULL
);
INSERT INTO inventory.availability_activation_runs(id, mode, state)
VALUES (44, 'activation', 'active');

CREATE TABLE inventory.availability_runtime_authority (
  singleton_key boolean PRIMARY KEY,
  authority varchar(20) NOT NULL,
  revision bigint NOT NULL,
  activation_run_id bigint
);
INSERT INTO inventory.availability_runtime_authority(singleton_key, authority, revision, activation_run_id)
VALUES (true, 'canonical', 9, 44);

CREATE TABLE channels.channels (
  id integer PRIMARY KEY,
  provider varchar(40) NOT NULL
);
INSERT INTO channels.channels(id, provider) VALUES (3, 'shopify');

CREATE TABLE dropship.dropship_store_connections (
  id integer PRIMARY KEY,
  platform varchar(40) NOT NULL
);

CREATE TABLE inventory.inventory_publication_targets (
  id integer PRIMARY KEY,
  state varchar(20) NOT NULL,
  revision bigint NOT NULL,
  destination_kind varchar(30) NOT NULL,
  channel_id integer NOT NULL,
  channel_connection_id integer,
  dropship_store_connection_id integer,
  provider_scope_type varchar(30) NOT NULL,
  external_scope_id varchar(240) NOT NULL,
  publication_authority varchar(30) NOT NULL,
  hold_reason varchar(120),
  held_at timestamptz,
  held_by varchar(100)
);
INSERT INTO inventory.inventory_publication_targets(
  id, state, revision, destination_kind, channel_id, channel_connection_id,
  provider_scope_type, external_scope_id, publication_authority
) VALUES (5, 'preview', 3, 'channel_connection', 3, 33, 'location', 'location-1', 'echelon');

CREATE TABLE catalog.product_variants (
  id integer PRIMARY KEY,
  product_id integer NOT NULL,
      inventory_tracking_override boolean
    );
CREATE TABLE inventory.publication_variant_mapping_versions (
  id integer PRIMARY KEY,
  lifecycle_status varchar(20) NOT NULL,
  external_inventory_item_id varchar(240) NOT NULL
);
CREATE TABLE inventory.publication_variant_mapping_heads (
  publication_target_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  active_mapping_id integer
);
CREATE TABLE inventory.inventory_publication_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  publication_target_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  external_inventory_item_id_snapshot varchar(240) NOT NULL
);
CREATE TABLE inventory.inventory_publication_readbacks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id bigint,
  publication_target_id integer NOT NULL,
  product_variant_id integer NOT NULL,
  external_inventory_item_id_snapshot varchar(240)
);

CREATE TABLE public.audit_events (
  id bigserial PRIMARY KEY,
  timestamp timestamptz NOT NULL DEFAULT transaction_timestamp(),
  level text NOT NULL DEFAULT 'AUDIT',
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  changes jsonb,
  context jsonb
);
CREATE TABLE public.idempotency_keys (
  key text PRIMARY KEY,
  request_hash text NOT NULL,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  expires_at timestamptz
);

CREATE FUNCTION inventory.reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only relation';
END;
$$;
`;

dbDescribe.sequential("scoped inventory publication target resume", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationTargetResumeService;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    await database.pool.query(readFileSync(resolve(
      process.cwd(),
      "migrations/0670_inventory_publication_target_resume.sql",
    ), "utf8"));
    service = new InventoryPublicationTargetResumeService(
      new PostgresInventoryPublicationTargetResumeStore(database.pool),
      { now: () => NOW },
    );
  }, 30_000);

  beforeEach(async () => {
    await database.pool.query(`TRUNCATE inventory.inventory_publication_target_resume_reviews,
      inventory.inventory_publication_readbacks, inventory.inventory_publication_outbox,
      inventory.publication_variant_mapping_heads, inventory.publication_variant_mapping_versions,
      catalog.product_variants, public.audit_events, public.idempotency_keys RESTART IDENTITY`);
    await database.pool.query(`UPDATE inventory.inventory_publication_targets
      SET state='preview', revision=3, publication_authority='echelon' WHERE id=5`);
  });

  afterAll(async () => {
    await database?.close();
  });

  function reviewRequest(idempotencyKey: string, overrides: Record<string, unknown> = {}) {
    return {
      publicationTargetId: 5,
      expectedRevision: "3",
      idempotencyKey,
      reason: "Revalidate the stopped Shopify target before restoring publication",
      ...overrides,
    };
  }

  async function recordPriorStop(): Promise<void> {
    await database.pool.query(
      `INSERT INTO public.audit_events(actor,action,target)
       VALUES ('operator-7','inventory_availability.publication_target.stopped',
               'inventory.inventory_publication_target:5')`,
    );
  }

  it("persists immutable blocked readiness evidence and replays it idempotently", async () => {
    await recordPriorStop();
    const first = await service.review(reviewRequest("resume-review-atomic"), "operator-7");
    const replay = await service.review(reviewRequest("resume-review-atomic"), "operator-7");

    expect(first).toMatchObject({
      resumeReviewId: "1",
      publicationTargetId: 5,
      publicationTargetRevision: "3",
      authorityRevision: "9",
      activationRunId: "44",
      state: "blocked",
      blockers: [{ code: "INVENTORY_PUBLICATION_TARGET_RESUME_MAPPING_MISSING" }],
      providerWriteAttempted: false,
      outboxEnqueued: false,
      alreadyApplied: false,
    });
    expect(replay).toEqual({ ...first, alreadyApplied: true });

    const row = (await database.pool.query(`SELECT configuration_hash,evidence_hash,
      evidence_payload,request_hash FROM inventory.inventory_publication_target_resume_reviews`)).rows[0];
    expect(row.configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.evidence_payload).toMatchObject({ publicationTargetId: 5, state: "blocked" });
    await expect(database.pool.query(
      `UPDATE inventory.inventory_publication_target_resume_reviews SET state='ready' WHERE id=1`,
    )).rejects.toThrow("append-only relation");
  });

  it("requires audited prior-live stop lineage and exact idempotent inputs", async () => {
    await expect(service.review(reviewRequest("resume-review-no-stop"), "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_RESUME_PRIOR_STOP_REQUIRED" });
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM inventory.inventory_publication_target_resume_reviews",
    )).rows[0].count).toBe(0);

    await recordPriorStop();
    await service.review(reviewRequest("resume-review-conflict"), "operator-7");
    await expect(service.review(reviewRequest("resume-review-conflict", {
      reason: "A different reviewed recovery reason",
    }), "operator-7")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_IDEMPOTENCY_CONFLICT",
    });
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM inventory.inventory_publication_target_resume_reviews",
    )).rows[0].count).toBe(1);
  });

  it("rejects a blocked review without changing target state or creating a resume receipt", async () => {
    await recordPriorStop();
    const review = await service.review(reviewRequest("resume-review-blocked"), "operator-7");

    await expect(service.resume({
      publicationTargetId: 5,
      expectedRevision: "3",
      resumeReviewId: review.resumeReviewId,
      expectedEvidenceHash: review.evidenceHash,
      idempotencyKey: "resume-blocked",
      reason: "Attempt only after the review reports complete readiness",
    }, "operator-7")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_BLOCKED",
    });
    expect((await database.pool.query(
      "SELECT state,revision::text FROM inventory.inventory_publication_targets WHERE id=5",
    )).rows[0]).toEqual({ state: "preview", revision: "3" });
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM public.idempotency_keys",
    )).rows[0].count).toBe(0);
  });

  it("blocks a historical provider identity omitted from current active mappings", async () => {
    await recordPriorStop();
    await database.pool.query(`INSERT INTO catalog.product_variants(id,product_id) VALUES(101,10);
      INSERT INTO inventory.inventory_publication_outbox(
        publication_target_id,product_variant_id,external_inventory_item_id_snapshot
      ) VALUES(5,101,'historical-item-101')`);

    const review = await service.review(reviewRequest("resume-review-historical-orphan"), "operator-7");

    expect(review).toMatchObject({
      state: "blocked",
      identityCensus: [{
        productId: 10,
        productVariantId: 101,
        externalInventoryItemId: "historical-item-101",
        evidenceSources: ["outbox"],
        coveredByCurrentMapping: false,
      }],
      blockers: [{
        code: "INVENTORY_PUBLICATION_TARGET_RESUME_HISTORICAL_IDENTITY_UNCOVERED",
        context: {
          productVariantId: 101,
          externalInventoryItemId: "historical-item-101",
        },
      }],
    });
    await expect(service.resume({
      publicationTargetId: 5,
      expectedRevision: "3",
      resumeReviewId: review.resumeReviewId,
      expectedEvidenceHash: review.evidenceHash,
      idempotencyKey: "resume-historical-orphan",
      reason: "Do not resume while a historical provider item is outside the absolute snapshot",
    }, "operator-7")).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_BLOCKED",
    });
  });

  it("enforces database payload, actor, revision, hash, and append-only constraints", async () => {
    await expect(database.pool.query(
      `INSERT INTO inventory.inventory_publication_target_resume_reviews(
         publication_target_id,publication_target_revision,authority_revision,activation_run_id,
         state,configuration_hash,readiness_hash,evidence_hash,evidence_payload,idempotency_key,request_hash,
         requested_by,reason,captured_at
       ) VALUES (5,0,9,44,'ready',$1,$1,$1,'[]'::jsonb,'bad-key',$1,'operator-7','reason',$2)`,
      [HASH, NOW],
    )).rejects.toThrow();
  });
});

dbDescribe.sequential("scoped inventory publication target resume composition", () => {
  let database: InventoryCutoverTestDatabase;
  let service: InventoryPublicationTargetResumeService;
  let publicationTargetId: number;
  let publicationTargetRevision: string;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(readFileSync(resolve(
      process.cwd(),
      "migrations/0670_inventory_publication_target_resume.sql",
    ), "utf8"));
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionChannelSeedSql);
    const masterDataClient = await database.pool.connect();
    try {
      await masterDataClient.query("BEGIN");
      await masterDataClient.query(`
      INSERT INTO inventory.promise_safety_policy_versions(
        scope_key, scope_type, product_variant_id, warehouse_id, version,
        policy_mode, definition_hash, change_reason, idempotency_key,
        request_hash, created_by
      ) VALUES
        ('network:variant:101','network_variant',101,NULL,1,'off',repeat('e',64),
         'Test network SKU policy','resume-network-safety',repeat('e',64),'operator'),
        ('warehouse:1:variant:101','warehouse_variant',101,1,1,'off',repeat('f',64),
         'Test warehouse SKU policy','resume-warehouse-safety',repeat('f',64),'operator')
    `);
      await masterDataClient.query(`
      INSERT INTO inventory.promise_safety_policy_heads(
        scope_key, draft_policy_id, revision, updated_by, update_reason
      )
      SELECT scope_key, id, 0, 'operator', 'Test complete safety scope activation'
      FROM inventory.promise_safety_policy_versions
      WHERE scope_key <> 'business'
    `);
      await masterDataClient.query(`
      UPDATE inventory.transformation_model_versions
      SET lifecycle_status='sealed', sealed_by='operator', sealed_at=$1
      WHERE lifecycle_status='draft'
    `, [NOW]);
      await masterDataClient.query(`
      UPDATE inventory.transformation_model_heads
      SET active_model_id=draft_model_id, draft_model_id=NULL,
          revision=revision+1, updated_by='operator',
          update_reason='Activate reviewed model for resume composition'
    `);
      await masterDataClient.query(`
      UPDATE inventory.promise_safety_policy_versions
      SET lifecycle_status='sealed', sealed_by='operator', sealed_at=$1
      WHERE lifecycle_status='draft'
    `, [NOW]);
      await masterDataClient.query(`
      UPDATE inventory.promise_safety_policy_heads
      SET active_policy_id=draft_policy_id, draft_policy_id=NULL,
          revision=revision+1, updated_by='operator',
          update_reason='Activate reviewed safety policy for resume composition'
    `);
      await masterDataClient.query(`
      UPDATE inventory.channel_exposure_policy_versions
      SET lifecycle_status='sealed', sealed_by='operator', sealed_at=$1
      WHERE lifecycle_status='draft'
    `, [NOW]);
      await masterDataClient.query(`
      UPDATE inventory.channel_exposure_policy_heads
      SET active_policy_id=draft_policy_id, draft_policy_id=NULL,
          revision=revision+1, updated_by='operator',
          update_reason='Activate reviewed channel exposure for resume composition'
    `);
      await masterDataClient.query(`
      UPDATE inventory.publication_source_binding_versions
      SET lifecycle_status='sealed', sealed_by='operator', sealed_at=$1
      WHERE lifecycle_status='draft'
    `, [NOW]);
      await masterDataClient.query(`
      UPDATE inventory.publication_source_binding_heads
      SET active_binding_id=draft_binding_id, draft_binding_id=NULL,
          revision=revision+1, updated_by='operator',
          update_reason='Activate reviewed source binding for resume composition'
    `);
      await masterDataClient.query(`
      UPDATE inventory.publication_variant_mapping_versions
      SET lifecycle_status='sealed', sealed_by='operator', sealed_at=$1
      WHERE lifecycle_status='draft'
    `, [NOW]);
      await masterDataClient.query(`
      UPDATE inventory.publication_variant_mapping_heads
      SET active_mapping_id=draft_mapping_id, draft_mapping_id=NULL,
          revision=revision+1, updated_by='operator',
          update_reason='Activate reviewed provider identity for resume composition'
      `);
      await masterDataClient.query("COMMIT");
    } catch (error) {
      await masterDataClient.query("ROLLBACK");
      throw error;
    } finally {
      masterDataClient.release();
    }

    const dryRun = (await database.pool.query<{ id: string }>(`
      INSERT INTO inventory.availability_activation_runs(
        mode, state, request_hash, result_hash,
        expected_catalog_input_hash, expected_catalog_result_hash,
        captured_catalog_input_hash, captured_catalog_result_hash,
        evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
        runtime_authority_changed, provider_write_attempted, outbox_enqueued,
        started_at, completed_at
      ) VALUES(
        'dry_run','ready_for_publication',$1,$1,$1,$1,$1,$1,
        '{}'::jsonb,'[]'::jsonb,'resume-composition-dry-run',
        'Fixture dry run owning the active canonical lineage','operator',
        false,false,false,$2,$2
      ) RETURNING id::text
    `, [HASH, NOW])).rows[0]!;
    const activation = (await database.pool.query<{ id: string }>(`
      INSERT INTO inventory.availability_activation_runs(
        mode, state, request_hash, result_hash,
        expected_catalog_input_hash, expected_catalog_result_hash,
        captured_catalog_input_hash, captured_catalog_result_hash,
        evidence_payload, blocker_codes, idempotency_key, reason, requested_by,
        runtime_authority_changed, provider_write_attempted, outbox_enqueued,
        started_at, completed_at, source_dry_run_id, prepared_at,
        publication_verified_at, activated_at, provider_publication_required
      ) VALUES(
        'activation','activating',$1,$1,$1,$1,$1,$1,
        '{}'::jsonb,'[]'::jsonb,'resume-composition-activation',
        'Fixture active canonical lineage for scoped resume','operator',
        true,false,false,$2,$2,$3,$2,$2,$2,false
      ) RETURNING id::text
    `, [HASH, NOW, dryRun.id])).rows[0]!;
    await database.pool.query(`
      UPDATE inventory.availability_runtime_authority
      SET authority='canonical', activation_run_id=$1, revision=revision+1,
          changed_by='operator', change_reason='Activate canonical resume composition',
          changed_at=$2
      WHERE singleton_key=true;
    `, [activation.id, NOW]);
    await database.pool.query(`
      UPDATE inventory.availability_activation_runs
      SET state='active', runtime_authority_changed=true
      WHERE id=$1
    `, [activation.id]);

    const target = (await database.pool.query<{ id: number; revision: string }>(`
      SELECT id, revision::text
      FROM inventory.inventory_publication_targets
      WHERE channel_connection_id=7
    `)).rows[0]!;
    publicationTargetId = target.id;
    publicationTargetRevision = target.revision;
    await database.pool.query(`
      INSERT INTO public.audit_events(timestamp,actor,action,target)
      VALUES($1,'operator-7','inventory_availability.publication_target.stopped',$2)
    `, [
      NOW,
      `inventory.inventory_publication_target:${publicationTargetId}`,
    ]);
    await database.pool.query(`
      INSERT INTO inventory.inventory_publication_readbacks(
        publication_target_id, product_variant_id, observed_quantity,
        matches_desired, evidence_hash, external_inventory_item_id_snapshot,
        destination_kind_snapshot, channel_connection_id_snapshot,
        dropship_store_connection_id_snapshot, provider_scope_type_snapshot,
        external_scope_id_snapshot, publication_target_revision_snapshot,
        observed_at
      ) VALUES($2,101,0,NULL,$3,'test-item','channel_connection',7,NULL,
               'location','test-location',$4,$1)
    `, [
      NOW,
      publicationTargetId,
      HASH,
      publicationTargetRevision,
    ]);
    service = new InventoryPublicationTargetResumeService(
      new PostgresInventoryPublicationTargetResumeStore(database.pool),
      { now: () => NOW },
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it("rolls back a post-CAS failure, then atomically resumes and replays the complete target snapshot", async () => {
    const review = await service.review({
      publicationTargetId,
      expectedRevision: publicationTargetRevision,
      idempotencyKey: "resume-composition-review",
      reason: "Review the exact stopped target before the composition resume",
    }, "operator-7");
    expect(review).toMatchObject({
      publicationTargetId,
      publicationTargetRevision,
      state: "ready",
      blockers: [],
      identityCensus: [{
        productId: 20,
        productVariantId: 101,
        externalInventoryItemId: "test-item",
        evidenceSources: ["active_mapping", "readback"],
        coveredByCurrentMapping: true,
      }],
      products: [{ productId: 20, target: { publishable: true } }],
    });
    const request = {
      publicationTargetId,
      expectedRevision: publicationTargetRevision,
      resumeReviewId: review.resumeReviewId,
      expectedEvidenceHash: review.evidenceHash,
      idempotencyKey: "resume-composition-command",
      reason: "Resume only the reviewed target with one complete absolute snapshot",
    };

    await database.pool.query(`
      CREATE FUNCTION public.fail_target_resume_outbox() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'test target resume outbox failure';
      END;
      $$;
      CREATE TRIGGER zz_target_resume_outbox_failure
      BEFORE INSERT ON inventory.inventory_publication_outbox
      FOR EACH ROW EXECUTE FUNCTION public.fail_target_resume_outbox();
    `);
    try {
      await expect(service.resume(request, "operator-7"))
        .rejects.toThrow("test target resume outbox failure");
    } finally {
      await database.pool.query(`
        DROP TRIGGER zz_target_resume_outbox_failure
        ON inventory.inventory_publication_outbox;
        DROP FUNCTION public.fail_target_resume_outbox();
      `);
    }
    expect((await database.pool.query(
      "SELECT state,revision::text FROM inventory.inventory_publication_targets WHERE id=$1",
      [publicationTargetId],
    )).rows).toEqual([{ state: "preview", revision: publicationTargetRevision }]);
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox",
    )).rows[0].count).toBe(0);
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM public.audit_events WHERE action='inventory_availability.publication_target.resumed'",
    )).rows[0].count).toBe(0);
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM public.idempotency_keys WHERE key=$1",
      [`inventory-publication-target-resume:${request.idempotencyKey}`],
    )).rows[0].count).toBe(0);

    const resumed = await service.resume(request, "operator-7");
    expect(resumed).toMatchObject({
      publicationTargetId,
      revision: (BigInt(publicationTargetRevision) + 1n).toString(),
      state: "live",
      resumeReviewId: review.resumeReviewId,
      evidenceHash: review.evidenceHash,
      publicationRows: 1,
      alreadyApplied: false,
      runtimeAuthorityChanged: false,
      providerWriteAttempted: false,
      outboxEnqueued: true,
    });
    expect((await database.pool.query(`
      SELECT publication_target_id, product_variant_id,
             desired_quantity::text, publication_target_revision_snapshot::text,
             state, external_inventory_item_id_snapshot
      FROM inventory.inventory_publication_outbox
      ORDER BY product_variant_id
    `)).rows).toEqual(review.products.flatMap((product) =>
      product.target.rows.map((row) => ({
        publication_target_id: publicationTargetId,
        product_variant_id: row.productVariantId,
        desired_quantity: row.publishedUnits,
        publication_target_revision_snapshot: resumed.revision,
        state: "queued",
        external_inventory_item_id_snapshot: row.mapping!.externalInventoryItemId,
      }))));
    const auditRows = (await database.pool.query(`
      SELECT actor,action,target,changes,context
      FROM public.audit_events
      WHERE action='inventory_availability.publication_target.resumed'
    `)).rows;
    expect(auditRows).toEqual([expect.objectContaining({
      actor: "operator-7",
      action: "inventory_availability.publication_target.resumed",
      target: `inventory.inventory_publication_target:${publicationTargetId}`,
      changes: {
        before: { state: "preview", revision: publicationTargetRevision },
        after: { state: "live", revision: resumed.revision },
      },
      context: expect.objectContaining({
        idempotencyKey: request.idempotencyKey,
        resumeReviewId: review.resumeReviewId,
        evidenceHash: review.evidenceHash,
        publicationRows: 1,
      }),
    })]);
    const receiptRows = (await database.pool.query(`
      SELECT request_hash,response_body
      FROM public.idempotency_keys
      WHERE key=$1
    `, [`inventory-publication-target-resume:${request.idempotencyKey}`])).rows;
    expect(receiptRows).toEqual([{
      request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      response_body: { commandType: "inventory_publication_target_resume", result: resumed },
    }]);

    await expect(service.resume(request, "operator-7"))
      .resolves.toEqual({ ...resumed, alreadyApplied: true });
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM inventory.inventory_publication_outbox",
    )).rows[0].count).toBe(1);
    expect((await database.pool.query(
      "SELECT count(*)::int AS count FROM public.audit_events WHERE action='inventory_availability.publication_target.resumed'",
    )).rows[0].count).toBe(1);
  }, 20_000);
});
