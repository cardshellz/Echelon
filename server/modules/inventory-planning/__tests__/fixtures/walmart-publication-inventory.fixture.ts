import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import {
  cutoverCompositionSeedSql,
  cutoverCompositionChannelSeedSql,
  installCutoverCompositionMigrations,
} from "./inventory-cutover-composition-database.fixture";

export const WALMART_INVENTORY_NOW = new Date("2026-09-27T12:00:00.000Z");
/** Real migrations/constraints, synthetic reviewed canonical lineage only in a
 * uniquely created disposable test database. This does not test global cutover. */
export async function installWalmartPublicationInventoryFixture(
  pool: Pool,
  options: { targetState?: "preview" | "live" } = {},
): Promise<void> {
  await installCutoverCompositionMigrations(pool);
  await pool.query(cutoverCompositionSeedSql);
  await pool.query(cutoverCompositionChannelSeedSql);
  for (const file of [
    "0709_walmart_quantity_admission.sql",
  ])
    await pool.query(
      readFileSync(resolve(process.cwd(), "migrations", file), "utf8"),
    );
  await pool.query(`
    ALTER TABLE catalog.products ADD COLUMN status text NOT NULL DEFAULT 'active';
    CREATE TABLE channels.channel_variant_overrides(channel_id integer NOT NULL,product_variant_id integer NOT NULL,sku_override text,
      UNIQUE(channel_id,product_variant_id));
    CREATE TABLE channels.walmart_connections(channel_id integer PRIMARY KEY,connection_id integer NOT NULL,
      partner_id text NOT NULL,environment text NOT NULL,ship_node_id text NOT NULL,warehouse_id integer NOT NULL);
    CREATE TABLE channels.channel_feeds(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,channel_id integer NOT NULL,
      product_variant_id integer NOT NULL,channel_sku text,channel_inventory_item_id text,is_active integer NOT NULL DEFAULT 1,quarantined_at timestamptz);
    UPDATE channels.channels SET provider='walmart',status='active' WHERE id=36;
    INSERT INTO channels.channel_connections(id,channel_id) VALUES(8,36);
    INSERT INTO channels.walmart_connections VALUES(36,8,'partner-36','production','test-location',1);
    INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(102,20,'NEW'),(103,20,'UNCERTAIN'),(104,20,'REJECTED'),(105,20,'FUTURE');
    INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
      external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES(36,8,1,'location','test-location','echelon','disabled','Selected Walmart inventory','operator');
    INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES(2,1,repeat('f',64),'Main source','walmart-binding',repeat('f',64),'operator');
    INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
      VALUES(2,2,1,'operator','Reviewed source');
    INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority) VALUES(2,2,1,1);
    INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,
      definition_hash,change_reason,idempotency_key,request_hash,created_by)
      VALUES(2,101,1,'P5','P5',repeat('a',64),'Exact Walmart SKU','walmart-mapping',repeat('a',64),'operator');
    INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
      VALUES(2,101,2,1,'operator','Reviewed item');
    INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id) VALUES(36,101,'P5','P5');
    UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=2;
  `);
  if ((options.targetState ?? "live") === "live") {
    await pool.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=2");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [versionTable, headTable, active, draft] of [
      [
        "transformation_model_versions",
        "transformation_model_heads",
        "active_model_id",
        "draft_model_id",
      ],
      [
        "promise_safety_policy_versions",
        "promise_safety_policy_heads",
        "active_policy_id",
        "draft_policy_id",
      ],
      [
        "channel_exposure_policy_versions",
        "channel_exposure_policy_heads",
        "active_policy_id",
        "draft_policy_id",
      ],
      [
        "publication_source_binding_versions",
        "publication_source_binding_heads",
        "active_binding_id",
        "draft_binding_id",
      ],
      [
        "publication_variant_mapping_versions",
        "publication_variant_mapping_heads",
        "active_mapping_id",
        "draft_mapping_id",
      ],
    ]) {
      await client.query(
        `UPDATE inventory.${versionTable} SET lifecycle_status='sealed',sealed_by='operator',sealed_at=$1 WHERE lifecycle_status='draft'`,
        [WALMART_INVENTORY_NOW],
      );
      await client.query(
        `UPDATE inventory.${headTable} SET ${active}=${draft},${draft}=NULL,revision=revision+1,updated_by='operator',update_reason='Fixture reviewed activation'`,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function activateWalmartPublicationInventoryFixture(
  pool: Pool,
): Promise<void> {
  const dry = (
    await pool.query<{ id: string }>(
      `INSERT INTO inventory.availability_activation_runs(
    mode,state,request_hash,result_hash,expected_catalog_input_hash,expected_catalog_result_hash,captured_catalog_input_hash,captured_catalog_result_hash,
    evidence_payload,blocker_codes,idempotency_key,reason,requested_by,started_at,completed_at)
    VALUES('dry_run','ready_for_publication',repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),
    '{}','[]','walmart-fixture-dry','Synthetic fixture lineage','operator',$1,$1) RETURNING id::text`,
      [WALMART_INVENTORY_NOW],
    )
  ).rows[0];
  const run = (
    await pool.query<{ id: string }>(
      `INSERT INTO inventory.availability_activation_runs(
    mode,state,request_hash,result_hash,expected_catalog_input_hash,expected_catalog_result_hash,captured_catalog_input_hash,captured_catalog_result_hash,
    evidence_payload,blocker_codes,idempotency_key,reason,requested_by,started_at,completed_at,source_dry_run_id,prepared_at,publication_verified_at,activated_at,provider_publication_required)
    VALUES('activation','activating',repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),repeat('a',64),
    '{}','[]','walmart-fixture-active','Synthetic fixture lineage','operator',$1,$1,$2,$1,$1,$1,false) RETURNING id::text`,
      [WALMART_INVENTORY_NOW, dry.id],
    )
  ).rows[0];
  await pool.query(
    `UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=$1,revision=revision+1,
    changed_by='operator',change_reason='Fixture canonical owner',changed_at=$2 WHERE singleton_key=true`,
    [run.id, WALMART_INVENTORY_NOW],
  );
  await pool.query(
    "UPDATE inventory.availability_activation_runs SET state='active',runtime_authority_changed=true WHERE id=$1",
    [run.id],
  );
}
