import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { ActivationDryRunProduct } from "@shared/types/inventory-availability-phase4";
import { captureProposedSupplySnapshotInsideTransaction } from "../../infrastructure/inventory-availability-shadow.repository";
import { PostgresInventoryAvailabilityActivationDryRunRepository } from "../../infrastructure/inventory-availability-activation-dry-run.repository";
import { inventoryCutoverEvidenceHash } from "../../domain/inventory-cutover-manifest";
import { sealSupplySnapshot } from "../../domain/inventory-availability-planner";
import { loadProposedPublicationTargetsForCutover } from "../../infrastructure/inventory-channel-exposure-runtime.repository";
import { planInventoryChannelExposureProduct } from "../../application/inventory-channel-exposure-runtime.service";
import { cutoverShipmentSchemaFixtureSql } from "./inventory-cutover-shipment-schema.fixture";
import { cutoverReceiptSchemaFixtureSql } from "./inventory-cutover-receipt-schema.fixture";

/** Existing base-owner columns plus the real ATP migrations. No ATP/fence function is substituted. */
export const cutoverCompositionBaseSql = `
CREATE SCHEMA inventory; CREATE SCHEMA wms; CREATE SCHEMA oms; CREATE SCHEMA warehouse; CREATE SCHEMA catalog;
CREATE SCHEMA channels; CREATE SCHEMA dropship;
CREATE TABLE channels.channels(id integer PRIMARY KEY,name text NOT NULL,provider text NOT NULL);
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer NOT NULL REFERENCES channels.channels(id));
CREATE TABLE dropship.dropship_vendors(id integer PRIMARY KEY,business_name text NOT NULL);
CREATE TABLE dropship.dropship_store_connections(id integer PRIMARY KEY,vendor_id integer REFERENCES dropship.dropship_vendors(id),platform text DEFAULT 'ebay',status text DEFAULT 'disconnected',external_display_name text,external_account_id text,shop_domain text);
CREATE TABLE catalog.products(id integer PRIMARY KEY,sku text,name text NOT NULL DEFAULT 'Pack',inventory_strategy text NOT NULL DEFAULT 'physical_only',is_active boolean NOT NULL DEFAULT true);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products(id),sku text,name text NOT NULL DEFAULT 'P5',
 units_per_variant integer NOT NULL DEFAULT 5,uom_type text DEFAULT 'pack',hierarchy_level integer DEFAULT 1,is_active boolean DEFAULT true,requires_shipping boolean DEFAULT true,track_inventory boolean DEFAULT true,sales_eligibility text DEFAULT 'sellable',UNIQUE(id,product_id));
CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY,code text NOT NULL DEFAULT 'MAIN',name text DEFAULT 'Main',warehouse_type text DEFAULT 'operations',inventory_source_type text DEFAULT 'internal',inventory_source_config jsonb,hub_warehouse_id integer,is_active integer DEFAULT 1,created_at timestamptz DEFAULT now());
CREATE TABLE warehouse.warehouse_locations(id integer PRIMARY KEY,warehouse_id integer REFERENCES warehouse.warehouses(id),code text DEFAULT 'PICK',location_type text DEFAULT 'pick',is_active integer DEFAULT 1,is_pickable integer DEFAULT 1,cycle_count_freeze_id integer);
CREATE TABLE warehouse.product_locations(id integer PRIMARY KEY,product_variant_id integer REFERENCES catalog.product_variants(id),warehouse_location_id integer REFERENCES warehouse.warehouse_locations(id),name text DEFAULT 'Slot',location text DEFAULT 'PICK',zone text DEFAULT 'PICK',is_primary integer DEFAULT 1,status text DEFAULT 'active');
CREATE TABLE inventory.build_recipes(id integer PRIMARY KEY,code text NOT NULL,version integer NOT NULL,status text NOT NULL,output_product_id integer REFERENCES catalog.products(id),name text DEFAULT 'Recipe',recipe_type text DEFAULT 'conversion',output_variant_id integer REFERENCES catalog.product_variants(id),output_units_per_variant integer NOT NULL,output_qty integer NOT NULL);
CREATE TABLE inventory.build_recipe_components(id integer PRIMARY KEY,recipe_id integer REFERENCES inventory.build_recipes(id),component_product_id integer REFERENCES catalog.products(id),component_variant_id integer REFERENCES catalog.product_variants(id),component_units_per_variant integer NOT NULL,qty integer NOT NULL);
CREATE TABLE wms.orders(id integer PRIMARY KEY,warehouse_id integer,warehouse_status text,on_hold integer,channel_id integer,source text,external_order_id text,oms_fulfillment_order_id text,fulfillment_partition_key text);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer,oms_order_line_id bigint,source_item_id text,sku text,product_id integer,quantity integer,picked_quantity integer,fulfilled_quantity integer,status text,on_hold boolean,requires_shipping integer,location text,short_reason text,picked_at timestamptz);
${cutoverShipmentSchemaFixtureSql}
CREATE TABLE wms.order_build_demands(id integer PRIMARY KEY,order_id integer,order_item_id integer,target_variant_id integer,root_build_order_id integer,status text,requested_qty integer,promised_qty integer);
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,status text);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint,product_variant_id integer,sku text,requires_shipping boolean,quantity integer,authority_fulfillable_quantity integer,wms_materialized_quantity integer,authorization_status text);
${cutoverReceiptSchemaFixtureSql}
CREATE TABLE oms.order_item_costs(id integer GENERATED BY DEFAULT AS IDENTITY(START WITH 100) PRIMARY KEY,order_id integer,order_item_id integer,inventory_lot_id integer,product_variant_id integer,qty integer,unit_cost_mills bigint,total_cost_mills bigint,created_at timestamptz,unit_cost_cents bigint,total_cost_cents bigint);
CREATE TABLE inventory.inventory_levels(id integer PRIMARY KEY,warehouse_location_id integer REFERENCES warehouse.warehouse_locations(id),product_variant_id integer REFERENCES catalog.product_variants(id),variant_qty integer,reserved_qty integer,picked_qty integer,packed_qty integer,backorder_qty integer DEFAULT 0,updated_at timestamptz);
CREATE TABLE inventory.inventory_lots(id integer PRIMARY KEY,warehouse_location_id integer,product_variant_id integer,qty_on_hand integer,qty_reserved integer,qty_picked integer,status text,received_at timestamptz,
 unit_cost_mills bigint,po_unit_cost_mills bigint,packaging_cost_mills bigint,landed_cost_mills bigint,total_unit_cost_mills bigint,
 unit_cost_cents bigint DEFAULT 0,po_unit_cost_cents bigint DEFAULT 0,packaging_cost_cents bigint DEFAULT 0,landed_cost_cents bigint DEFAULT 0,total_unit_cost_cents bigint DEFAULT 0);
CREATE TABLE inventory.inventory_transactions(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,order_id integer,order_item_id integer,product_variant_id integer,to_location_id integer,from_location_id integer,
 transaction_type text,variant_qty_delta integer,variant_qty_before integer,variant_qty_after integer,reserved_qty_delta integer,source_state text,target_state text,reference_type text,reference_id text,
 user_id text,notes text,voided_at timestamptz,created_at timestamptz DEFAULT now(),unit_cost_cents bigint,inventory_lot_id integer,shipment_id integer,shipment_item_id integer);
CREATE TABLE inventory.build_orders(id integer PRIMARY KEY,status text,warehouse_id integer);
CREATE TABLE inventory.build_order_components(id integer PRIMARY KEY,build_order_id integer,component_variant_id integer,source_location_id integer);
CREATE TABLE inventory.build_component_reservations(id integer PRIMARY KEY,build_order_component_id integer,inventory_lot_id integer,reserved_qty integer,consumed_qty integer,released_qty integer,reservation_owner text,availability_claim_id bigint,availability_claim_lot_allocation_id bigint);
CREATE TABLE public.audit_events(id bigserial PRIMARY KEY,timestamp timestamptz DEFAULT transaction_timestamp(),level text DEFAULT 'AUDIT',actor text NOT NULL,action text NOT NULL,target text,changes jsonb,context jsonb);
CREATE TABLE public.idempotency_keys(key text PRIMARY KEY,request_hash text NOT NULL,response_body jsonb,created_at timestamptz DEFAULT transaction_timestamp(),expires_at timestamptz);
`;

// Historical prerequisite order matches the existing foundation integration suite,
// not a lexical replay of this repository's mixed-era migration filenames.
export async function installCutoverCompositionMigrations(pool: Pool): Promise<void> {
  for (const file of [
    "211_inventory_availability_foundation.sql", "214_inventory_planner_shadow_evidence.sql",
    "0622_inventory_availability_backfill_review.sql", "0623_inventory_claim_simulation_activation_outbox.sql",
    "0628_inventory_backfill_provenance_refresh.sql", "0654_inventory_manual_transformation_review.sql",
    "0630_inventory_demand_evidence_observation_days.sql", "0632_inventory_channel_exposure_policy.sql",
    "0633_inventory_publication_readiness.sql", "0638_inventory_availability_cutover.sql",
    "0652_inventory_publication_destination_owners.sql", "220_inventory_publication_outbox_destination_owners.sql",
    "0640_inventory_availability_claim_lineage.sql", "0642_inventory_availability_claim_execution_contract.sql",
    "0647_inventory_availability_claim_pick_lineage.sql", "0649_inventory_availability_claim_replacement.sql",
    "233_inventory_cutover_reconstruction.sql", "234_inventory_canonical_shipment_compatibility.sql",
    "235_inventory_cutover_commit_evidence.sql",
    "237_inventory_quantity_publication_admission.sql",
    "0663_quantity_provider_request_evidence.sql",
  ]) await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
}

export const cutoverCompositionSeedSql = `
INSERT INTO warehouse.warehouses(id) VALUES(1);
INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(100,1);
INSERT INTO catalog.products(id,sku) VALUES(20,'PACK');
INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(101,20,'P5');
INSERT INTO wms.orders VALUES(1,1,'ready',0,36,'shopify','example-1','fo-1','default');
INSERT INTO wms.order_items(id,order_id,oms_order_line_id,source_item_id,sku,product_id,quantity,picked_quantity,fulfilled_quantity,status,on_hold,requires_shipping,location,short_reason)
 VALUES(11,1,11,'source-11','P5',101,6,2,0,'pending',false,1,'PICK',NULL);
INSERT INTO inventory.inventory_levels(id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty,packed_qty) VALUES(10,100,101,20,3,2,0);
INSERT INTO inventory.inventory_lots(id,warehouse_location_id,product_variant_id,qty_on_hand,qty_reserved,qty_picked,status,received_at,unit_cost_mills,po_unit_cost_mills,packaging_cost_mills,landed_cost_mills,total_unit_cost_mills)
 VALUES(4,100,101,20,3,2,'active','2026-09-01T00:00:00Z',9007199254740995,9007199254740995,0,0,9007199254740995);
INSERT INTO inventory.inventory_transactions(order_id,order_item_id,product_variant_id,to_location_id,from_location_id,transaction_type,variant_qty_delta,reserved_qty_delta,source_state,target_state)
 VALUES(1,11,101,100,NULL,'reserve',0,5,'on_hand','committed'),(1,11,101,NULL,100,'pick',-2,-2,'on_hand','picked');
INSERT INTO oms.order_item_costs(id,order_id,order_item_id,inventory_lot_id,product_variant_id,qty,unit_cost_mills,total_cost_mills,created_at)
 VALUES(9,1,11,4,101,2,9007199254740995,18014398509481990,'2026-09-06T12:00:00Z');
INSERT INTO inventory.transformation_model_versions(product_id,version,build_to_promise_enabled,definition_hash,validation_state,validation_errors,change_reason,idempotency_key,request_hash,created_by)
 VALUES(20,1,false,repeat('c',64),'valid','[]','Test exact model','composition-model',repeat('c',64),'operator');
INSERT INTO inventory.transformation_model_heads(product_id,draft_model_id,revision,updated_by,update_reason)
 SELECT 20,id,0,'operator','Test reviewed model' FROM inventory.transformation_model_versions;
INSERT INTO inventory.promise_safety_policy_versions(scope_key,scope_type,version,policy_mode,definition_hash,change_reason,idempotency_key,request_hash,created_by)
 VALUES('business','business',1,'off',repeat('d',64),'Test safety off','composition-safety',repeat('d',64),'operator');
INSERT INTO inventory.promise_safety_policy_heads(scope_key,draft_policy_id,revision,updated_by,update_reason)
 SELECT 'business',id,0,'operator','Test reviewed safety' FROM inventory.promise_safety_policy_versions;
`;

/** Supplies historical reviewed evidence from the real captured graph; the cutover
 * owner still has to validate every persisted selection against current state.
 * This fixture does not claim to exercise the preceding admin approval workflow.
 */
export async function seedCompositionReviewedDryRun(pool: Pool, capturedAt?: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const recorded = await captureProposedSupplySnapshotInsideTransaction(client, 20);
    // Controlled fixture clocks must also govern the historical review packet.
    // Otherwise database wall time can put preparation after a fixed activation.
    // Preserve the actual graph and reseal it using the normal validated contract.
    const { snapshotFingerprint: _fingerprint, ...content } = recorded;
    const snapshot = capturedAt === undefined ? recorded : sealSupplySnapshot({ ...content, capturedAt });
    const targets = await loadProposedPublicationTargetsForCutover(client,20,[101]);
    const exposure = planInventoryChannelExposureProduct({ authority:"canonical",authorityRevision:"1",activationRunId:"1",
      supplySnapshot:snapshot,managedSellableVariantIds:[101],publicationTargets:targets },20);
    const observedTargets=(await client.query<{ id:number;channel_id:number;channel_connection_id:number;revision:string;
      publication_authority:"external_provider"|"manual";provider_scope_type:"account"|"location";external_scope_id:string;provider:string }>(
      `SELECT target.id,target.channel_id,target.channel_connection_id,target.revision::text,target.publication_authority,
       target.provider_scope_type,target.external_scope_id,channel.provider FROM inventory.inventory_publication_targets target
       JOIN channels.channels channel ON channel.id=target.channel_id WHERE target.publication_authority<>'echelon' AND target.state<>'disabled' ORDER BY target.id`,
    )).rows;
    await client.query("COMMIT");
    const model = snapshot.transformationModels[0];
    const shadow = (await pool.query<{ id: string }>(
      `INSERT INTO inventory.planner_shadow_runs(product_id,model_id,model_version,model_definition_hash,
       legacy_inventory_strategy,snapshot_fingerprint,snapshot_payload,status,idempotency_key,requested_by,captured_at,completed_at)
       VALUES(20,$1,$2,$3,$4,$5,$6::jsonb,'completed','composition-shadow','operator',$7,$7) RETURNING id::text`,
      [model.modelId,model.version,model.definitionHash,snapshot.legacyInventoryStrategy,snapshot.snapshotFingerprint,JSON.stringify(snapshot),snapshot.capturedAt],
    )).rows[0].id;
    const product: ActivationDryRunProduct = {
      productId:20,queueState:"approved",status:"ready",draftModelId:model.modelId,draftModelVersion:model.version,
      draftDefinitionHash:model.definitionHash,reviewId:"1",shadowRunId:shadow,
      shadowSnapshotFingerprint:snapshot.snapshotFingerprint,channelPreviewHash:inventoryCutoverEvidenceHash([]),
      proposedPublications:exposure.targets.flatMap((target) => target.rows.map((row) => ({
        publicationTargetId:target.publicationTargetId,productVariantId:row.productVariantId,channelId:target.channelId,
        destinationKind:target.destinationKind,channelConnectionId:target.channelConnectionId,dropshipStoreConnectionId:target.dropshipStoreConnectionId,
        channelProvider:target.channelProvider,providerScopeType:target.providerScopeType,externalScopeId:target.externalScopeId,
        publicationAuthority:target.publicationAuthority,publicationTargetRevision:target.publicationTargetRevision,disposition:"publish" as const,
        canonicalAtpUnits:row.canonicalAtpUnits,legacyCalculatedUnits:row.canonicalAtpUnits,desiredUnits:row.publishedUnits,differenceFromLastAcknowledgedUnits:"0",
        sourceBindingId:target.sourceBinding!.bindingId,sourceBindingVersion:target.sourceBinding!.version,
        sourceBindingDefinitionHash:target.sourceBinding!.definitionHash,sourceWarehouseIds:target.sourceBinding!.warehouseIds,
        sourceWarehouseBreakdown:row.sourceWarehouseBreakdown,mappingId:row.mapping!.mappingId,mappingVersion:row.mapping!.version,
        mappingDefinitionHash:row.mapping!.definitionHash,externalInventoryItemId:row.mapping!.externalInventoryItemId,externalSku:row.mapping!.externalSku,
        policySelections:target.selectedPolicies.map((policy) => ({ ...policy,authority:"draft" as const })),
      }))),publicationEvidence:[],blockers:[],
    };
    const summary = { totalProducts:1,readyProducts:1,blockedProducts:0,publicationRows:product.proposedPublications.length };
    // Observe-only destinations are included in the reviewed target census, but
    // carry no Echelon quantity promise, source binding or publication command.
    product.proposedPublications.push(...observedTargets.map(target => ({ publicationTargetId:target.id,productVariantId:101,
      channelId:target.channel_id,destinationKind:"channel_connection" as const,channelConnectionId:target.channel_connection_id,dropshipStoreConnectionId:null,
      channelProvider:target.provider,providerScopeType:target.provider_scope_type,externalScopeId:target.external_scope_id,
      publicationAuthority:target.publication_authority,publicationTargetRevision:target.revision,disposition:"observe_only" as const,
      canonicalAtpUnits:"0",legacyCalculatedUnits:"0",desiredUnits:"0",differenceFromLastAcknowledgedUnits:null,sourceBindingId:null,
      sourceBindingVersion:null,sourceBindingDefinitionHash:null,sourceWarehouseIds:[],sourceWarehouseBreakdown:[],mappingId:null,mappingVersion:null,
      mappingDefinitionHash:null,externalInventoryItemId:null,externalSku:null,policySelections:[],
    })));
    summary.publicationRows=product.proposedPublications.length;
    for (const row of product.proposedPublications) {
      if (row.disposition!=="publish") continue;
      // Mock external observation persisted through the actual readback schema.
      await pool.query(`INSERT INTO inventory.inventory_publication_readbacks(publication_target_id,product_variant_id,
        observed_quantity,matches_desired,evidence_hash,external_inventory_item_id_snapshot,destination_kind_snapshot,
        channel_connection_id_snapshot,provider_scope_type_snapshot,external_scope_id_snapshot,publication_target_revision_snapshot,observed_at)
        VALUES($1,$2,20,NULL,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.publicationTargetId,row.productVariantId,inventoryCutoverEvidenceHash(row),row.externalInventoryItemId,row.destinationKind,
        row.channelConnectionId,row.providerScopeType,row.externalScopeId,row.publicationTargetRevision,snapshot.capturedAt]);
    }
    const evidenceHash = inventoryCutoverEvidenceHash({ summary,products:[product],blockers:[] });
    return await new PostgresInventoryAvailabilityActivationDryRunRepository(pool).persistActivationDryRun({
      requestHash:evidenceHash,resultHash:evidenceHash,expectedCatalogInputHash:evidenceHash,expectedCatalogResultHash:evidenceHash,
      catalogInputHash:evidenceHash,catalogResultHash:evidenceHash,idempotencyKey:"composition-dry-run",reason:"Reviewed actual graph",
      requestedBy:"operator",startedAt:new Date(snapshot.capturedAt),completedAt:new Date(snapshot.capturedAt),
      state:"ready_for_publication",summary,products:[product],blockers:[],
    });
  } catch(error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export const cutoverCompositionChannelSeedSql = `
INSERT INTO channels.channels(id,name,provider) VALUES(36,'Test Shopify','shopify');
INSERT INTO channels.channel_connections(id,channel_id) VALUES(7,36);
INSERT INTO warehouse.fulfillment_nodes(code,name,node_type,warehouse_id,inventory_authority,fulfillment_authority,created_by)
 VALUES('COMPOSITION','Main','internal_warehouse',1,'echelon','echelon','operator');
UPDATE warehouse.fulfillment_nodes SET lifecycle_status='active',activated_by='operator',activated_at=transaction_timestamp();
INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
 external_scope_id,publication_authority,state,change_reason,created_by)
 VALUES(36,7,1,'location','test-location','echelon','disabled','Composition target','operator');
INSERT INTO inventory.channel_exposure_policy_versions(scope_key,channel_id,scope_type,version,allocation_semantics,
 eligible,share_bps,holdback_sellable_units,max_publish_mode,min_publish_sellable_units,definition_hash,change_reason,idempotency_key,request_hash,created_by)
 VALUES('channel:36',36,'channel',1,'exposure',true,10000,0,'unlimited',0,repeat('e',64),'Full exposure','composition-exposure',repeat('e',64),'operator');
INSERT INTO inventory.channel_exposure_policy_heads(scope_key,channel_id,draft_policy_id,revision,updated_by,update_reason)
 VALUES('channel:36',36,1,1,'operator','Reviewed exposure');
INSERT INTO inventory.publication_source_binding_versions(publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
 VALUES(1,1,repeat('f',64),'Main source','composition-binding',repeat('f',64),'operator');
INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
 VALUES(1,1,1,'operator','Reviewed source');
INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority) VALUES(1,1,1,1);
INSERT INTO inventory.publication_variant_mapping_versions(publication_target_id,product_variant_id,version,external_inventory_item_id,external_sku,
 definition_hash,change_reason,idempotency_key,request_hash,created_by)
 VALUES(1,101,1,'test-item','P5',repeat('a',64),'Exact item','composition-mapping',repeat('a',64),'operator');
INSERT INTO inventory.publication_variant_mapping_heads(publication_target_id,product_variant_id,draft_mapping_id,revision,updated_by,update_reason)
 VALUES(1,101,1,1,'operator','Reviewed item');
UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp();
`;

export const cutoverCompositionObserveOnlySeedSql = `
INSERT INTO channels.channel_connections(id,channel_id) VALUES(8,36);
INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,fulfillment_node_id,provider_scope_type,
 external_scope_id,publication_authority,state,change_reason,created_by)
 VALUES(36,8,1,'location','external-canada','external_provider','disabled','Existing external provider','operator');
UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='operator',activated_at=transaction_timestamp() WHERE id=2;
UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=2;
`;
