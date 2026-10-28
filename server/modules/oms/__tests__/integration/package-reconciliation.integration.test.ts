import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestDb, getTestPool, runMigrations, truncateTestData, closeTestDb, describeWithDisposableDb } from "../../../../../test/setup-integration";
import { installLabelCommercialIntegrationFixtures, seedCommercialFulfillmentAuthoritySource } from "../../../shipping/__tests__/fixtures/label-commercial-integration.fixture";
import { normalizeShipStationLabelObservation } from "../../../shipping/carrier-tracking.domain";
import { createPackageAllocationLabelCommercialWorkflow } from "../../../../services/package-allocation-label-commercial-workflow";
import { PackageAllocationLabelCommercialFulfillmentService } from "../../../shipping/package-allocation-label-commercial-fulfillment.service";
import { createChannelFulfillmentAuthorityRepository } from "../../channel-fulfillment-authority.repository";
import { createChannelFulfillmentProjector } from "../../channel-fulfillment-projection.repository";
import { packageReconciliationInputFromProof, type PackageProviderProof, type PackageReconciliationCommand } from "../../package-reconciliation.repository";
import { planPackageReconciliation } from "../../package-reconciliation.domain";

const now = new Date("2026-09-17T14:00:00Z");
const actor = "package-reconciliation-admin";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
type SeedLabel = { id: number; shipmentId: number; orderId: number; orderKey: string; trackingNumber: string; isReturnLabel: false; shipmentItems: { lineItemKey: string; quantity: number }[] };

describeWithDisposableDb("current package reconciliation owner", () => {
  let pool: Pool;
  let handler: PackageAllocationLabelCommercialFulfillmentService;
  beforeAll(async () => { await runMigrations(); pool = getTestPool(); await installLabelCommercialIntegrationFixtures(pool); });
  beforeEach(async () => {
    await truncateTestData();
    await pool.query("INSERT INTO identity.users(id,username,password,role) VALUES($1::text,$1::text,'test-only','admin')", [actor]);
    handler = new PackageAllocationLabelCommercialFulfillmentService({ enabled: true, logger,
      labelLinker: { reconcileShipStationLabel: vi.fn().mockResolvedValue({ linksInserted: 0, totalLinks: 0 }) }, reviewRepository: { record: vi.fn() },
      workflow: createPackageAllocationLabelCommercialWorkflow({ pool, clock: { now: () => now }, logger }) });
  });
  afterAll(closeTestDb);

  async function label(shipmentId: number, lines: { source: number; quantity: number }[], orderId = 99001): Promise<SeedLabel> {
    const value = { shipmentId, orderId, orderKey: `provider-order-key-${orderId}`, trackingNumber: `PKG${shipmentId}`, carrierCode: "ups", serviceCode: "ups_ground",
      isReturnLabel: false as const, voidDate: null, shipmentItems: lines.map(item => ({ lineItemKey: `wms-item-${item.source}`, quantity: item.quantity })) };
    const observation = normalizeShipStationLabelObservation(value, new Date("2026-09-17T12:00:00Z"));
    const row = await pool.query(`INSERT INTO wms.shipping_provider_labels(provider,provider_label_id,provider_order_id,provider_order_key,tracking_number,normalized_tracking_number,
      label_status,label_direction,carrier,first_observed_at,last_observed_at) VALUES('shipstation',$1,$2,$3,$4,$4,'active','outbound','ups',$5,$5) RETURNING id`,
      [String(shipmentId), String(orderId), value.orderKey, value.trackingNumber, observation.observedAt]);
    const id = Number(row.rows[0].id);
    await pool.query(`INSERT INTO wms.shipping_provider_label_events(shipping_provider_label_id,event_hash,event_type,label_status,tracking_number,provider_occurred_at,received_at,sanitized_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id,observation.eventHash,observation.eventType,observation.labelStatus,observation.trackingNumber,observation.providerOccurredAt,observation.observedAt,observation.sanitizedPayload]);
    await pool.query(`INSERT INTO wms.shipping_provider_label_links(shipping_provider_label_id,legacy_wms_shipment_id)
      SELECT $1,shipment_id FROM wms.outbound_shipment_items WHERE id=ANY($2::integer[]) GROUP BY shipment_id`,[id,lines.map(item=>item.source)]);
    return { ...value, id };
  }
  async function receive(value: SeedLabel) { return handler.process(value, { shippingProviderLabelId: String(value.id) } as never); }
  async function voidLabel(value: SeedLabel) {
    const observation = normalizeShipStationLabelObservation({ ...value, voidDate: "2026-09-17T13:00:00Z", carrierCode: "ups" }, new Date("2026-09-17T13:00:00Z"));
    await pool.query(`INSERT INTO wms.shipping_provider_label_events(shipping_provider_label_id,event_hash,event_type,label_status,tracking_number,provider_occurred_at,received_at,sanitized_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [value.id,observation.eventHash,observation.eventType,observation.labelStatus,observation.trackingNumber,observation.providerOccurredAt,observation.observedAt,observation.sanitizedPayload]);
    await pool.query("UPDATE wms.shipping_provider_labels SET label_status='voided',voided_at=$2,last_observed_at=$2 WHERE id=$1", [value.id,observation.observedAt]);
  }
  async function seedPicked(source: number, quantity: number) {
    await pool.query('UPDATE wms.order_items SET picked_quantity=$2 WHERE id=(SELECT order_item_id FROM wms.outbound_shipment_items WHERE id=$1)',[source,quantity]);
    await pool.query(`INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id)
      SELECT 'pick',$2,order_item.order_id,order_item.id FROM wms.outbound_shipment_items item JOIN wms.order_items order_item ON order_item.id=item.order_item_id WHERE item.id=$1`, [source,-quantity]);
  }
  async function command(sourceIds: number[], proof: PackageProviderProof | null = null, correctedIds: number[] = []): Promise<PackageReconciliationCommand> {
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const snapshot = await repository.loadPackageReconciliationSnapshot!(sourceIds);
    const correction = correctedIds.length ? { kind: "confirmed_package_contents_correction" as const, actorId: actor, reason: "Confirmed merged parcel contents", previousLabelIds: correctedIds } : null;
    const input = packageReconciliationInputFromProof(snapshot, proof, correction);
    const plan = planPackageReconciliation(input);
    expect(plan).toMatchObject({ outcome: "ready" });
    if (plan.outcome !== "ready") throw new Error("Fixture did not produce a ready plan");
    return { commandKey: "integration-package-reconciliation", expectedSnapshotHash: snapshot.hash, expectedPlanHash: plan.evidenceHash,
      sourceItemIds: sourceIds, actor, reason: "Verify current packages and preserve picked inventory", mode: "adopt_existing", providerProof: proof, correction };
  }
  async function splitFixture() {
    const source = await seedCommercialFulfillmentAuthoritySource(pool, "SPLIT-SKU", 3);
    const original = await label(81001, [{source,quantity:1}]); expect(await receive(original)).toMatchObject({outcome:"activated"});
    const sibling = await label(81002, [{source,quantity:1}],99002); expect(await receive(sibling)).toMatchObject({outcome:"activated"});
    await voidLabel(original);
    await label(81003, [{source,quantity:1}],99003); await label(81004, [{source,quantity:1}]);
    await seedPicked(source,3);
    return { source, original, sibling };
  }

  async function mergeFixture(withEarlierPackage:boolean) {
    const a=await seedCommercialFulfillmentAuthoritySource(pool,"MERGE-A",withEarlierPackage?3:15);
    const b=await seedCommercialFulfillmentAuthoritySource(pool,"MERGE-B",withEarlierPackage?2:12);
    await pool.query("UPDATE wms.outbound_shipments SET engine_order_ref='99002',shipstation_order_key='provider-order-key-99002' WHERE id=(SELECT shipment_id FROM wms.outbound_shipment_items WHERE id=$1)",[b]);
    const original=await label(82001,[{source:a,quantity:withEarlierPackage?3:15}]);
    expect(await receive(original)).toMatchObject({outcome:"activated"});
    let earlier:SeedLabel|null=null;
    if(withEarlierPackage){
      earlier=await label(82002,[{source:b,quantity:2}],99002);expect(await receive(earlier)).toMatchObject({outcome:"activated"});
      const event=(await pool.query("INSERT INTO wms.carrier_tracking_events(dispatch_evidence,event_occurred_at,received_at) VALUES('confirmed','2026-09-17T12:10Z','2026-09-17T12:10Z') RETURNING id")).rows[0].id;
      await pool.query("INSERT INTO wms.carrier_tracking_event_matches(carrier_tracking_event_id,shipping_provider_label_id,attempt_hash,match_status) VALUES($1,$2,$3,'matched')",[event,earlier.id,'a'.repeat(64)]);
    }
    await voidLabel(original);
    await label(82003,[{source:a,quantity:withEarlierPackage?3:15},{source:b,quantity:withEarlierPackage?2:12}]);
    await seedPicked(a,withEarlierPackage?3:15);await seedPicked(b,withEarlierPackage?2:12);
    const snapshot=await createChannelFulfillmentAuthorityRepository(getTestDb()).loadPackageReconciliationSnapshot!([a]);
    const proof:PackageProviderProof={observedAt:now.toISOString(),relationships:[{providerOrderId:'99001',mergedProviderOrderIds:['99002'],parentProviderOrderId:null,evidenceHash:'b'.repeat(64)}],
      labels:snapshot.evidence.map(evidence=>{const label=evidence.label!;const input=snapshot.input.labels.find(item=>item.labelId===Number(label.id))!;
        return{labelId:Number(label.id),providerLabelId:label.provider_label_id,providerOrderId:label.provider_order_id!,providerOrderKey:label.provider_order_key,
          trackingNumber:label.tracking_number,carrier:'ups',serviceCode:null,outbound:true,status:label.label_status as 'active'|'voided',contents:input.contents,evidenceHash:'c'.repeat(64)};})};
    return{a,b,earlier,proof};
  }

  it("materializes the relabel and unused split portion exactly once without another pick/ship debit", async () => {
    const { source, sibling } = await splitFixture();
    const before = (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows;
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const request = await command([source]);
    const first = await repository.reconcilePackages!(request,now);
    expect(first.physicalShipmentIds).toHaveLength(2); expect(first.channelCommandIds).toHaveLength(2);
    expect(await repository.reconcilePackages!(request,now)).toMatchObject({...first,replayed:true});
    expect((await pool.query("SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items")).rows).toEqual([{quantity:3}]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.physical_shipment_item_quantity_adjustments")).rows).toEqual([{count:1}]);
    expect((await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows).toEqual(before);
    expect((await pool.query("SELECT label_status FROM wms.shipping_provider_labels WHERE id=$1",[sibling.id])).rows).toEqual([{label_status:"active"}]);
    expect((await pool.query("SELECT push_status,last_error_code FROM oms.channel_fulfillment_pushes WHERE id=ANY($1::bigint[])",[first.channelCommandIds])).rows)
      .toEqual(Array(2).fill({push_status:"review",last_error_code:"PACKAGE_RECONCILIATION_READBACK_PENDING"}));
  });
  it("rolls back every allocation when a target materialization fails", async () => {
    const { source } = await splitFixture(); const request = await command([source]);
    await pool.query(`CREATE FUNCTION wms.fail_test_reconciliation_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.provider_physical_shipment_id='81004' THEN RAISE EXCEPTION 'injected target failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fail_test_reconciliation_target BEFORE INSERT ON wms.physical_shipments FOR EACH ROW EXECUTE FUNCTION wms.fail_test_reconciliation_target()`);
    try { await expect(createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(request,now)).rejects.toThrow("injected target failure"); }
    finally { await pool.query("DROP TRIGGER fail_test_reconciliation_target ON wms.physical_shipments; DROP FUNCTION wms.fail_test_reconciliation_target()"); }
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.package_reconciliation_commands")).rows).toEqual([{count:0}]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.physical_shipment_item_quantity_adjustments")).rows).toEqual([{count:0}]);
    expect((await pool.query("SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items")).rows).toEqual([{quantity:2}]);
  });
  it("rejects stale previews and conflicting command replays", async () => {
    const { source } = await splitFixture(); const request = await command([source]);
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    await expect(repository.reconcilePackages!({...request,expectedSnapshotHash:"0".repeat(64)},now)).rejects.toMatchObject({code:"STALE_PACKAGE_SNAPSHOT"});
    await repository.reconcilePackages!(request,now);
    await expect(repository.reconcilePackages!({...request,reason:"Different operation"},now)).rejects.toMatchObject({code:"RECONCILIATION_REPLAY_CONFLICT"});
  });
  it('rejects unsupported historical channel adoption before reserving a receipt or changing quantities', async () => {
    const { source } = await splitFixture();
    await pool.query("UPDATE channels.channels SET provider='ebay'");
    const request = await command([source]);
    const before = (await pool.query('SELECT * FROM inventory.inventory_transactions ORDER BY id')).rows;
    await expect(createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(request, now))
      .rejects.toMatchObject({ code: 'CHANNEL_SCOPE_UNSUPPORTED' });
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM oms.package_reconciliation_commands')).rows).toEqual([{ count: 0 }]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM wms.physical_shipment_item_quantity_adjustments')).rows).toEqual([{ count: 0 }]);
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{ quantity: 2 }]);
    expect((await pool.query('SELECT * FROM inventory.inventory_transactions ORDER BY id')).rows).toEqual(before);
  });
  it("database guards reject a negative-only correction without an applied conserving receipt", async () => {
    const { source } = await splitFixture();
    const item = (await pool.query("SELECT id FROM wms.physical_shipment_items ORDER BY id LIMIT 1")).rows[0].id;
    await expect(pool.query(`INSERT INTO wms.physical_shipment_item_quantity_adjustments(physical_shipment_item_id,quantity_delta,adjustment_kind,repair_run_id,idempotency_key,operator,reason,metadata,created_at)
      VALUES($1,-1,'provider_package_reconciliation','11111111-1111-4111-8111-111111111111','invalid-test','operator','invalid', '{"reconciliationCommandId":99999}',now())`,[item])).rejects.toMatchObject({code:"23514"});
    expect((await pool.query("SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items")).rows).toEqual([{quantity:2}]);
    expect((await command([source])).sourceItemIds).toEqual([source]);
  });
  it("materializes a merged 15 plus 12 parcel, including the companion's missing canonical request",async()=>{
    const{a,b,proof}=await mergeFixture(false);
    const before=(await pool.query('SELECT * FROM inventory.inventory_transactions ORDER BY id')).rows;
    const request=await command([a],proof);
    const result=await createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(request,now);
    expect(result.physicalShipmentIds).toHaveLength(1);expect(result.omsOrderIds).toHaveLength(2);
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{quantity:27}]);
    expect((await pool.query('SELECT quantity_requested FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id=$1',[b])).rows).toEqual([{quantity_requested:12}]);
    await createChannelFulfillmentProjector(getTestDb()).projectReconciledPhysicalShipment(result.physicalShipmentIds[0]);
    expect((await pool.query('SELECT status,tracking_number,external_fulfillment_id FROM wms.outbound_shipments ORDER BY id')).rows)
      .toEqual(Array(2).fill({ status: 'shipped', tracking_number: 'PKG82003', external_fulfillment_id: null }));
    expect((await pool.query('SELECT * FROM inventory.inventory_transactions ORDER BY id')).rows).toEqual(before);
  });
  it("reconciles a confirmed five-unit merge while retaining the earlier carrier and physical evidence",async()=>{
    const{a,earlier,proof}=await mergeFixture(true);
    const beforeCarrier=(await pool.query('SELECT * FROM wms.carrier_tracking_events ORDER BY id')).rows;
    const beforeItems=(await pool.query('SELECT id,quantity_shipped FROM wms.physical_shipment_items ORDER BY id')).rows;
    const request=await command([a],proof,[earlier!.id]);
    const result=await createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(request,now);
    expect(result.correctedPreviousLabelIds).toEqual([earlier!.id]);
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{quantity:5}]);
    expect((await pool.query("SELECT label_status FROM wms.shipping_provider_labels WHERE id=$1",[earlier!.id])).rows).toEqual([{label_status:'active'}]);
    expect((await pool.query('SELECT * FROM wms.carrier_tracking_events ORDER BY id')).rows).toEqual(beforeCarrier);
    expect((await pool.query('SELECT id,quantity_shipped FROM wms.physical_shipment_items WHERE id=ANY($1::bigint[]) ORDER BY id',[beforeItems.map(item=>item.id)])).rows).toEqual(beforeItems);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM inventory.inventory_transactions')).rows).toEqual([{count:2}]);
  });
  it('rolls back WMS and OMS projection if a reconciled header update fails', async () => {
    const { a, proof } = await mergeFixture(false);
    const result = await createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(await command([a], proof), now);
    const snapshot = async () => ({
      orders: (await pool.query('SELECT * FROM wms.orders ORDER BY id')).rows,
      items: (await pool.query('SELECT * FROM wms.order_items ORDER BY id')).rows,
      omsOrders: (await pool.query('SELECT * FROM oms.oms_orders ORDER BY id')).rows,
      omsLines: (await pool.query('SELECT * FROM oms.oms_order_lines ORDER BY id')).rows,
      headers: (await pool.query('SELECT * FROM wms.outbound_shipments ORDER BY id')).rows,
      inventory: (await pool.query('SELECT * FROM inventory.inventory_transactions ORDER BY id')).rows,
    });
    const before = await snapshot();
    await pool.query(`CREATE FUNCTION wms.fail_reconciled_header_projection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected reconciliation header failure'; END; $$;
      CREATE TRIGGER fail_reconciled_header_projection BEFORE UPDATE ON wms.outbound_shipments
      FOR EACH ROW EXECUTE FUNCTION wms.fail_reconciled_header_projection()`);
    try {
      await expect(createChannelFulfillmentProjector(getTestDb(), () => now)
        .projectReconciledPhysicalShipment(result.physicalShipmentIds[0])).rejects.toThrow('injected reconciliation header failure');
    } finally {
      await pool.query('DROP TRIGGER fail_reconciled_header_projection ON wms.outbound_shipments; DROP FUNCTION wms.fail_reconciled_header_projection()');
    }
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT state FROM oms.package_reconciliation_commands')).rows).toEqual([{ state: 'applied' }]);
  });
  it("serializes concurrent identical reconciliation commands and replays the committed result",async()=>{
    const{source}=await splitFixture();const request=await command([source]);
    const repository=createChannelFulfillmentAuthorityRepository(getTestDb());
    const results=await Promise.all([repository.reconcilePackages!(request,now),repository.reconcilePackages!(request,now),repository.reconcilePackages!(request,now)]);
    expect(new Set(results.map(result=>result.commandId)).size).toBe(1);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM oms.package_reconciliation_commands')).rows).toEqual([{count:1}]);
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{quantity:3}]);
  });
  it("the automatic replacement path includes unused split capacity after predecessor channel correction", async () => {
    const { source, original } = await splitFixture();
    await pool.query(`INSERT INTO oms.shopify_label_void_work(shipping_provider_label_id,physical_shipment_id,oms_order_id,state,created_at,updated_at,completed_at)
      SELECT $1,package.id,command.oms_order_id,'complete',$2,$2,$2 FROM wms.physical_shipments package
      JOIN oms.channel_fulfillment_pushes command ON command.physical_shipment_id=package.id
      WHERE package.provider_physical_shipment_id=$3`, [original.id, now, String(original.shipmentId)]);
    const target = Number((await pool.query("SELECT id FROM wms.shipping_provider_labels WHERE provider_label_id='81003'")).rows[0].id);
    const result = await createChannelFulfillmentAuthorityRepository(getTestDb()).reconcileEbayLabelReplacement!(target, now);
    expect(result).toMatchObject({ outcome: 'applied' });
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{ quantity: 3 }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.package_reconciliation_commands WHERE mode='live'")).rows).toEqual([{ count: 1 }]);
  });
  it("uses exact provider contents when an order-list observation mutated the old voided label", async () => {
    const { a, b, proof } = await mergeFixture(false);
    const old = proof.labels.find(label => label.status === 'voided')!;
    await voidLabel({ id: old.labelId, shipmentId: Number(old.providerLabelId), orderId: Number(old.providerOrderId),
      orderKey: old.providerOrderKey!, trackingNumber: old.trackingNumber, isReturnLabel: false,
      shipmentItems: [{ lineItemKey: `wms-item-${a}`, quantity: 15 }, { lineItemKey: `wms-item-${b}`, quantity: 12 }] });
    const request = await command([a], proof);
    await createChannelFulfillmentAuthorityRepository(getTestDb()).reconcilePackages!(request, now);
    expect((await pool.query('SELECT SUM(quantity_shipped)::int AS quantity FROM wms.effective_physical_shipment_items')).rows).toEqual([{ quantity: 27 }]);
  });
  it("adopts exact native readbacks, refuses wrong quantities, and replays completion without extra attempts",async()=>{
    const{source}=await splitFixture();const request=await command([source]);const repository=createChannelFulfillmentAuthorityRepository(getTestDb());
    const result=await repository.reconcilePackages!(request,now);
    for(const physicalId of result.physicalShipmentIds){await createChannelFulfillmentProjector(getTestDb()).projectReconciledPhysicalShipment(physicalId);await repository.markPackageReconciliationProjected!(result.commandId,physicalId,now);}
    const scopes=await repository.readPackageReconciliationChannelScopes!(result.commandId);
    const readbacks=scopes.map((scope,index)=>({physicalShipmentId:scope.physicalShipmentId,omsOrderId:scope.omsOrderId,channelId:scope.channelId,
      fulfillmentId:`gid://shopify/Fulfillment/${9000+index}`,trackingNumber:scope.trackingNumber,items:[...scope.items],observedAt:now.toISOString()}));
    await expect(repository.completePackageReconciliation!(result.commandId,readbacks.map((readback,index)=>index?readback:{...readback,items:readback.items.map(item=>({...item,quantity:2}))}),now)).rejects.toMatchObject({code:'CHANNEL_PACKAGE_SCOPE_CONFLICT'});
    expect(await repository.completePackageReconciliation!(result.commandId,readbacks,now)).toMatchObject({replayed:false});
    const before=(await pool.query('SELECT * FROM oms.channel_fulfillment_push_attempts ORDER BY id')).rows;
    expect(await repository.completePackageReconciliation!(result.commandId,readbacks,now)).toMatchObject({replayed:true});
    expect(await repository.completePackageReconciliation!(result.commandId,readbacks,new Date(now.getTime()+86_400_000))).toMatchObject({replayed:true});
    expect((await pool.query('SELECT * FROM oms.channel_fulfillment_push_attempts ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT push_status FROM oms.channel_fulfillment_pushes WHERE id=ANY($1::bigint[])',[result.channelCommandIds])).rows).toEqual(Array(2).fill({push_status:'success'}));
  });
});
