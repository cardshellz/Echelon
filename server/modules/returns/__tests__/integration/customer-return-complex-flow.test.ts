import { PostgresPackageHistoryStore } from "../../../shipping/package-history.repository";
import { PostgresSalesChannelDeliveryEvidenceStore } from "../../../shipping/sales-channel-delivery.repository";
import { deriveSalesChannelDeliveryEvidence } from "../../../shipping/sales-channel-delivery.domain";
import { PostgresCustomerReturnProgressReader } from "../../infrastructure/customer-return-progress.reader";
import { PostgresCustomerOrderDeliveryReader } from "../../../shipping/customer-order-delivery.reader";
import { CarrierTrackingService } from "../../../shipping/carrier-tracking.service";
import { createDrizzleCarrierTrackingRepository } from "../../../shipping/carrier-tracking.repository";
import { SavedLabelStatusWorker } from "../../../shipping/saved-label-status.worker";
import { enqueueSavedLabelStatus, SAVED_LABEL_STATUS_LEASE_MS, PostgresSavedLabelStatusStore } from "../../../shipping/saved-label-status.repository";
import { createSavedLabelStatusSource } from "../../../shipping/saved-label-status.source";
import { normalizeSavedLabelStatusObservation } from "../../../shipping/saved-label-status.domain";
import { CustomerReturnCustomerOperationsService } from "../../application/customer-return-customer-operations.service";
import { CustomerReturnOrderAccessService } from "../../application/customer-return-order-access.service";
import { PostgresCustomerReturnOrderAccessRepository } from "../../infrastructure/customer-return-order-access.repository";
import { PostgresCustomerReturnCustomerOwnershipReader } from "../../infrastructure/customer-return-customer-ownership.repository";
import { shipStationReturnWorkflowFixture } from "../support/shipstation-return-workflow-fixture";
import { downloadCustomerReturnLabel } from "../../infrastructure/customer-return-label-download";
import { CustomerReturnWorkflowWorker } from "../../application/customer-return-workflow.worker";
import { PostgresCustomerReturnWorkflowStore, RETURN_WORKFLOW_LEASE_MS } from "../../infrastructure/customer-return-workflow.repository";
import { PostgresCustomerReturnAuthorizationStore } from "../../infrastructure/customer-return-authorization.repository";
import { ReturnParcelReceivingService } from "../../application/return-parcel-receiving.service";
import { PostgresReturnParcelReceivingStore } from "../../infrastructure/return-parcel-receiving.repository";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "@shared/schema";
import type { CustomerReturnLabelSubmitInput } from "@shared/returns/customer-return-label.contract";
import {
  ReturnLabelProviderError,
  type ReturnLabelInput,
  type ReturnLabelRecord,
  type ReturnLabelProvider,
} from "../../../shipping-engine/application/return-label-provider.port";
import type { ReturnRateProvider } from "../../../shipping-engine/application/return-rate-provider.port";
import { CustomerReturnLiveService } from "../../application/customer-return-live.service";
import { CustomerReturnSubmissionService } from "../../application/customer-return-submission.service";
import { CustomerReturnLabelsService } from "../../application/customer-return-labels.service";
import { CustomerReturnLabelSettingsService } from "../../application/customer-return-label-settings.service";
import { PostgresCustomerReturnSubmissionStore } from "../../infrastructure/customer-return-submission.repository";
import { PostgresCustomerReturnIntakeStore } from "../../infrastructure/customer-return-intake.repository";
import { PostgresCustomerReturnLabelStore } from "../../infrastructure/customer-return-labels.repository";
import { PostgresCustomerReturnSettingsStore } from "../../infrastructure/customer-return-label-settings.repository";
import { PostgresCustomerReturnPortalPolicyReader } from "../../infrastructure/customer-return-policy.reader";
import { PostgresCustomerReturnLocalInspectionReader } from "../../infrastructure/customer-return-local-inspection.reader";
import { ReturnCaseOperationService } from "../../application/return-case-operations.service";
import { PostgresReturnCaseOperationStore } from "../../infrastructure/return-case-operation.repository";
import { resolveReturnsTestDatabase } from "../support/disposable-database";
import {
  createIntakeTestSchema,
  publishIntakeTestPolicyShipping,
  createIntakeActionProjectionSchema,
  INTAKE_NOW,
} from "../support/customer-return-intake-database";
import {
  COMPLEX_KEY,
  COMPLEX_SCOPE,
  complexHistory,
  complexProvider,
  complexRequest,
  seedComplexSource,
} from "../support/complex-return-scenario";

// Only the legacy module's global DB connection is redirected. Its actual
// transaction, SQL, quantity owner, audit owner and receipt service still run.
const globalConnection = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../../../db", () => ({
  db: { transaction: globalConnection.transaction },
}));

const connectionString = resolveReturnsTestDatabase(process.env, "intake");
const integration = connectionString ? describe.sequential : describe.skip;
const otherKey = "19370000-0000-4000-8000-000000000002";

integration(
  "connected three-shipment customer return with two repacked boxes",
  () => {
    let pool: Pool;
    let instant: Date;
    let leaseSequence: number;
    beforeAll(async () => {
      pool = new Pool({
        connectionString: connectionString!,
        max: 8,
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      });
      await createIntakeTestSchema(pool);
      const operations = readFileSync(
        "migrations/200_return_case_operations.sql",
        "utf8",
      );
      // Inspection table is already retained by the intake fixture. Apply the
      // rest of its canonical operation DDL, preserving all actual constraints.
      await pool.query(
        operations.slice(
          0,
          operations.indexOf("CREATE TABLE returns.return_case_inspections"),
        ),
      );
      await pool.query(
        operations.slice(
          operations.indexOf("CREATE TABLE returns.return_case_commands"),
        ),
      );
      // Install the real inspection/disposition owners and database guards.
      await pool.query(
        "DROP TABLE returns.return_case_inventory_treatment_items,returns.return_case_inventory_treatments,returns.return_case_disposition_items,returns.return_case_dispositions",
      );
      await pool.query(
        readFileSync(
          "migrations/201_return_case_inspection_completion.sql",
          "utf8",
        ),
      );
      await pool.query(
        readFileSync("migrations/203_return_case_dispositions.sql", "utf8"),
      );
      await pool.query(
        readFileSync(
          "migrations/204_return_case_inventory_treatments.sql",
          "utf8",
        ),
      );
      await pool.query(
        readFileSync("migrations/0107_audit_events.sql", "utf8"),
      );
      await pool.query(
        readFileSync(
          "migrations/900000041000019450003_return_parcel_receipts.sql",
          "utf8",
        ),
      );
      await createIntakeActionProjectionSchema(pool);
      await pool.query(readFileSync("migrations/900000036000019300001_shipping_package_history.sql", "utf8"));
      const dispatch = readFileSync("migrations/165_carrier_dispatch_authority_cutover.sql", "utf8");
      await pool.query(dispatch.slice(0,dispatch.indexOf("CREATE TABLE IF NOT EXISTS wms.carrier_dispatch_attempts")));

      const database = drizzle(pool, { schema });
      globalConnection.transaction.mockImplementation(
        (work: Parameters<typeof database.transaction>[0]) =>
          database.transaction(work),
      );
    });
    beforeEach(async () => {
      instant = new Date(INTAKE_NOW);
      leaseSequence = 0;
      await pool.query("TRUNCATE wms.saved_label_status_jobs CASCADE");
      await seedComplexSource(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    async function setup(legacy = false, beforePersist?: () => Promise<void>, carrier?: ReturnLabelProvider) {
      if (legacy) await seedComplexSource(pool, true);
      const database = drizzle(pool, { schema });
      const provider = complexProvider();
      const history = complexHistory(provider);
      const local = new PostgresCustomerReturnLocalInspectionReader(pool, {
        approvedShopDomains: ["test-shop.myshopify.com"],
        clock: () => new Date(instant),
      });
      const live = new CustomerReturnLiveService({
        local,
        shopify: { read: async () => structuredClone(provider) },
        policies: new PostgresCustomerReturnPortalPolicyReader(database),
        dimensions: {
          read: async () => ({
            lengthMm: 254,
            widthMm: 203.2,
            heightMm: 101.6,
          }),
        },
        packageHistory: { read: async () => (legacy ? history : null) },
        now: () => new Date(instant),
      });
      const settings = new CustomerReturnLabelSettingsService({
        store: new PostgresCustomerReturnSettingsStore(database),
        authorizeChannel: async (channel) => {
          expect(channel).toBe(36);
        },
        now: () => new Date(instant),
        capabilities: async () => ({
          configured: true,
          carriers: [
            {
              id: "se-123",
              code: "usps",
              name: "USPS",
              services: [
                { code: "usps_ground_advantage", name: "Ground Advantage" },
              ],
            },
          ],
        }),
      });
      const savedProviderLabels = new Map<string, ReturnLabelRecord>();
      const quote = vi.fn<ReturnRateProvider["quote"]>(async () => ({
        status: "completed",
        exclusions: [],
        rates: [
          {
            carrierId: "se-123",
            carrierCode: "usps",
            serviceCode: "usps_ground_advantage",
            amountCents: 503,
            currency: "USD",
            rateId: null,
            rateType: "quick",
            packageType: null,
            trackable: true,
            validationStatus: "valid",
            warningCount: 0,
            amounts: {
              shippingCents: 503,
              insuranceCents: 0,
              confirmationCents: 0,
              otherCents: 0,
            },
          },
        ],
      }));
      const makeLabel = (input: ReturnLabelInput): ReturnLabelRecord => ({
        labelId: `se-label-${input.externalShipmentId}`,
        shipmentId: `se-shipment-${input.externalShipmentId}`,
        externalShipmentId: input.externalShipmentId,
        trackingNumber: `TEST-${input.externalShipmentId}`,
        carrierId: input.carrierId,
        serviceCode: input.serviceCode,
        amountCents: 503,
        currency: "USD",
        downloadUrl: `https://api.shipstation.com/v2/downloads/${input.externalShipmentId}.pdf`,
        labelFormat: "pdf",
        createdAt: instant.toISOString(),
      });
      const purchase = vi.fn<ReturnLabelProvider["purchase"]>(async (input) => {
        const result = makeLabel(input);
        savedProviderLabels.set(input.externalShipmentId, result);
        return result;
      });
      const recover = vi.fn<ReturnLabelProvider["recover"]>(
        async (input) =>
          savedProviderLabels.get(input.externalShipmentId) ?? null,
      );
      const labels = new CustomerReturnLabelsService({
        store: new PostgresCustomerReturnLabelStore(
          pool,
          () => new Date(instant),
        ),
        provider: carrier ?? { purchase, recover },
        rates: { quote },
        authorizeChannel: async (channel) => {
          expect(channel).toBe(36);
        },
        requirePurchaseConfiguration: (channel, authorization) =>
          settings.requireAcceptedShippingEnabled(channel, authorization),
        now: () => new Date(instant),
      });
      const intake = new PostgresCustomerReturnIntakeStore(
        database,
        () => new Date(instant),
      );
      const submission = new CustomerReturnSubmissionService({
        commands: new PostgresCustomerReturnSubmissionStore(pool),
        intake: {
          find: (input) => intake.find(input),
          persist: async (input) => {
            if (beforePersist) await beforePersist();
            return intake.persist(input);
          },
        },
        live,
        settings,
        labels,
        authorizeChannel: async (channel) => {
          expect(channel).toBe(36);
        },
        now: () => new Date(instant),
        newToken: () =>
          `19370000-0000-4000-8000-${String(++leaseSequence).padStart(12, "0")}`,
      });
      const inspection = await live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      const currentVersion = await new PostgresCustomerReturnSettingsStore(database).customerVersion(36);
      const config = await settings.requireEnabled(36, currentVersion!);
      const input = complexRequest(inspection, config.settings.version);
      return {
        live,
        provider,
        inspection,
        input,
        submission,
        labels,
        purchase,
        recover,
        savedProviderLabels,
        makeLabel,
      };
    }

    function workflow(s: Awaited<ReturnType<typeof setup>>) {
      const store = new PostgresCustomerReturnWorkflowStore(pool);
      const report = vi.fn();
      const worker = new CustomerReturnWorkflowWorker({ store, submissions: s.submission, labels: s.labels,
        now: () => new Date(instant), newToken: () => `19600000-0000-4000-8000-${String(++leaseSequence).padStart(12, "0")}`, report });
      const principal = { channelId: COMPLEX_SCOPE.channelId, externalCustomerId: COMPLEX_SCOPE.externalCustomerId };
      return { store, worker, report, principal,
        enqueue: () => store.enqueue({ request: s.input, scope: COMPLEX_SCOPE, actor: "customer:36:901", now: new Date(instant) }),
        read: () => store.readOwned(principal, s.input.idempotencyKey) };
    }
    it("uses the actual ShipStation adapter through purchase, readback, lost-response recovery and PDF download", async () => {
      await publishIntakeTestPolicyShipping(pool, { contactPhone: "555-010-1000" });
      const carrier = shipStationReturnWorkflowFixture(() => new Date(instant));
      const s = await setup(false, undefined, carrier.provider), w = workflow(s);
      carrier.loseNextPurchaseReply();
      await w.enqueue(); await w.worker.run(); await w.worker.run();
      expect(carrier.calls.filter(call => call.method === "POST")).toHaveLength(1);
      instant = new Date(instant.getTime() + 5_001);
      await w.worker.run(); await w.worker.run();
      const saved = (await w.read())!;
      expect(saved.phase).toBe("ready");
      expect(carrier.calls.filter(call => call.method === "POST")).toHaveLength(2);
      const ready = await s.labels.status(36, saved.authorizationId!);
      for (const parcel of ready.parcels) {
        const artifact = await s.labels.artifact(36, saved.authorizationId!, parcel.parcelId);
        const pdf = await downloadCustomerReturnLabel(artifact.downloadUrl, carrier.fetchFn);
        expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
      }
      expect(new Set(carrier.calls.filter(call => call.method === "POST").map(call => call.externalShipmentId)).size).toBe(2);
      expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(1);
    });
    it("finishes an explicitly queued mixed-box return without any browser continuation and receives both labels once", async () => {
      const s = await setup(), w = workflow(s);
      const before = await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions");
      expect((await w.enqueue()).phase).toBe("queued");
      expect((await w.enqueue()).phase).toBe("queued");
      expect(s.purchase).not.toHaveBeenCalled();
      await Promise.all([w.worker.run(), w.worker.run()]);
      expect((await w.read())?.phase).toBe("labels");
      expect(s.purchase).not.toHaveBeenCalled();
      await w.worker.run(); await w.worker.run(); await w.worker.run();
      const saved = (await w.read())!;
      expect(saved.phase).toBe("ready");
      expect(s.purchase).toHaveBeenCalledTimes(2);
      const ready = await s.labels.status(36, saved.authorizationId!);
      const boxes = new ReturnParcelReceivingService(new PostgresReturnParcelReceivingStore(), () => new Date(instant));
      for (const parcel of [...ready.parcels].reverse()) {
        const box = await boxes.lookup(parcel.trackingNumber!);
        const input = { idempotencyKey: `19600000-0000-4000-9000-${String(box.boxNumber).padStart(12, "0")}`, notes: null,
          lines: box.lines.map(line => ({ authorizationLineId: line.authorizationLineId, expectedCurrentReceivedQuantity: 0, quantityReceivedNow: line.expectedQuantity })) };
        await boxes.receive(box.parcelId, input, "synthetic-receiver");
        expect((await boxes.receive(box.parcelId, input, "retry")).replayed).toBe(true);
      }
      expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(1);
      expect((await pool.query("SELECT sum(received_qty)::int AS units FROM wms.return_items")).rows[0].units).toBe(13);
      expect((await pool.query("SELECT count(*)::int AS count FROM inventory.inventory_transactions")).rows).toEqual(before.rows);
      expect((await pool.query("SELECT count(*)::int AS count FROM returns.return_case_customer_refunds")).rows[0].count).toBe(0);
    });
    it("recovers a worker crash after a label commit through its original manifest without repurchasing", async () => {
      const s = await setup(), w = workflow(s);
      await w.enqueue(); await w.worker.run();
      const settle = vi.spyOn(w.store, "settle").mockRejectedValueOnce(new Error("lost checkpoint"));
      await expect(w.worker.run()).rejects.toThrow("lost checkpoint"); settle.mockRestore();
      expect(s.purchase).toHaveBeenCalledTimes(1);
      instant = new Date(instant.getTime() + RETURN_WORKFLOW_LEASE_MS + 1);
      const restarted = workflow(s);
      await restarted.worker.run(); await restarted.worker.run();
      expect((await restarted.read())?.phase).toBe("ready");
      expect(s.purchase).toHaveBeenCalledTimes(2);
      expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(1);
    });
    it("keeps original delivery, two return boxes, receiving and payment independent through actual capture and retries", async () => {
      await publishIntakeTestPolicyShipping(pool, { contactPhone: "555-010-1000" });
      const carrier=shipStationReturnWorkflowFixture(()=>new Date(instant));
      const s=await setup(false,undefined,carrier.provider), w=workflow(s);
      await w.enqueue();await w.worker.run();await w.worker.run();await w.worker.run();
      const saved=(await w.read())!, ready=await s.labels.status(36,saved.authorizationId!);
      await pool.query("UPDATE oms.oms_orders SET fulfillment_status='fulfilled' WHERE id=100");
      const historyStore=new PostgresPackageHistoryStore(pool,()=>new Date(instant));
      await historyStore.drain(1000,{orderIds:[100]});
      const claims=await historyStore.claim(1,instant,"19600000-0000-4000-8000-000000000099",{orderIds:[100]});
      expect(claims).toHaveLength(1);
      expect(await historyStore.complete(claims[0],complexHistory(s.provider),instant)).toBe(true);
      const outboundCodes=new Map([['SYNTHETIC-OUTBOUND-1','IT'],['SYNTHETIC-OUTBOUND-2','UN'],['SYNTHETIC-OUTBOUND-3','IT']]);
      const providerGet:typeof fetch=async(target,options)=>{
        const url=new URL(String(target));
        if(url.origin==='https://ssapi.shipstation.com'){
          expect(options?.method).toBe('GET');const number=url.searchParams.get('trackingNumber')!;
          const index=Number(number.split('-').at(-1));
          return Response.json({shipments:[{shipmentId:900+index,trackingNumber:number,isReturnLabel:false,voided:false,
            carrierCode:'ups',serviceCode:'ups_ground',shipDate:'2026-09-20',createDate:'2026-09-20T05:00:00',shipmentItems:[]}],page:1,pages:1,total:1});
        }
        if(/^\/v2\/labels\/se-90[123]$/.test(url.pathname)){
          const index=Number(url.pathname.slice(-1));
          return Response.json({label_id:`se-${900+index}`,tracking_number:`SYNTHETIC-OUTBOUND-${index}`,is_return_label:false,created_at:'2026-09-20T12:00:00Z'});
        }
        if(/^\/v2\/labels\/se-90[123]\/track$/.test(url.pathname)){
          expect(options?.method).toBe('GET');const index=Number(url.pathname.split('/').at(-2)!.slice(-1)),number=`SYNTHETIC-OUTBOUND-${index}`,code=outboundCodes.get(number)!;
          return Response.json({label_id:`se-${900+index}`,tracking_number:number,carrier_code:'ups',status_code:code,
            events:[{occurred_at:index===1&&code==='IT'?'2026-09-20T13:00:00Z':instant.toISOString(),status_code:code}]});
        }
        return carrier.fetchFn(target,options);
      };

      const scope={channelId:36,externalCustomerId:"901",orders:[{omsOrderId:100,externalOrderId:"1000"}]};
      const read=()=>new PostgresCustomerReturnProgressReader(pool).read(scope,instant);
      const first=(await read()).get(100)!;
      expect(first.returns).toHaveLength(1);
      expect(first.returns[0]).toMatchObject({status:{code:"label_ready"},refund:{code:"not_started"},quantity:13,receivedQuantity:0});
      await pool.query("UPDATE wms.saved_label_status_jobs SET last_error_code='SAVED_LABEL_STATUS_VOID_TIME_UNAVAILABLE' WHERE source_kind='return'");
      expect((await read()).get(100)!.returns[0].status.code).toBe("needs_attention");
      await pool.query("UPDATE wms.saved_label_status_jobs SET last_error_code=NULL WHERE source_kind='return'");
      expect((await read()).get(100)!.returns[0].status.code).toBe("label_ready");
      const immutable=await sourceFacts();
      const tracking=new CarrierTrackingService({repository:createDrizzleCarrierTrackingRepository(drizzle(pool)),clock:{now:()=>new Date(instant)},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
      const laterDelivery=structuredClone(s.provider);
      laterDelivery.fulfillments[0].deliveredAt='2026-09-21T12:00:00Z';
      const nativeRead=vi.fn(async()=>laterDelivery);
      const statusSource=createSavedLabelStatusSource({pool,now:()=>new Date(instant),v1Key:"synthetic-v1",v1Secret:"synthetic-secret",v2Key:"synthetic-status-key",request:providerGet,shopify:{read:nativeRead}});
      const channelEvidence=new PostgresSalesChannelDeliveryEvidenceStore(pool);
      const capture=new SavedLabelStatusWorker({store:new PostgresSavedLabelStatusStore(pool),
        channelEvidence,
        source:statusSource,
        tracking,now:()=>new Date(instant),newToken:()=>`19600000-0000-4000-8000-${String(++leaseSequence).padStart(12,"0")}`,report:vi.fn()});
      expect((await capture.run()).errors).toBe(0);
      expect(nativeRead).toHaveBeenCalledTimes(3);
      for(const call of nativeRead.mock.calls)expect(call).toHaveLength(1);
      const historicalEvidence=deriveSalesChannelDeliveryEvidence(complexHistory(s.provider),"901",laterDelivery,instant);
      await Promise.all([channelEvidence.append(historicalEvidence),channelEvidence.append(historicalEvidence)]);
      expect((await pool.query("SELECT count(*)::int AS n FROM wms.sales_channel_delivery_evidence")).rows[0].n).toBe(2);
      await expect(pool.query("UPDATE wms.sales_channel_delivery_evidence SET actor='changed'")).rejects.toThrow(/immutable/);
      const deliveryReader=new PostgresCustomerOrderDeliveryReader(pool);
      expect((await deliveryReader.read(scope,instant)).get(100)).toMatchObject({delivery:{code:"partially_delivered"},packages:expect.arrayContaining([{key:"physical:3",trackingNumber:"SYNTHETIC-OUTBOUND-3",status:{code:"in_transit",label:"In transit"}}])});
      expect((await pool.query("SELECT count(*)::int AS n FROM wms.shipping_provider_labels WHERE label_direction='return'")).rows[0].n).toBe(2);
      expect((await read()).get(100)!.returns[0].status.code).toBe("label_ready");
      carrier.setTracking(ready.parcels[0].trackingNumber!,"IT");
      instant=new Date(instant.getTime()+6*60*60_000+1);
      await Promise.all([capture.run(),capture.run()]);
      expect((await read()).get(100)!.returns[0].status.code).toBe("in_transit");
      for(const parcel of ready.parcels)carrier.setTracking(parcel.trackingNumber!,"DE");
      outboundCodes.set("SYNTHETIC-OUTBOUND-3","DE");
      instant=new Date(instant.getTime()+6*60*60_000+1);await capture.run();
      expect((await read()).get(100)!.returns[0]).toMatchObject({status:{code:"delivered"},receivedQuantity:0,refund:{code:"not_started"}});
      // Receiving a mixed box uses the existing receipt owner and remains idempotent.
      const boxes=new ReturnParcelReceivingService(new PostgresReturnParcelReceivingStore(),()=>new Date(instant));
      for(const [index,parcel]of ready.parcels.entries()){
        const box=await boxes.lookup(parcel.trackingNumber!);
        const command={idempotencyKey:`19600000-0000-4000-9000-${String(box.boxNumber).padStart(12,"0")}`,notes:null,
          lines:box.lines.map(line=>({authorizationLineId:line.authorizationLineId,expectedCurrentReceivedQuantity:0,quantityReceivedNow:line.expectedQuantity}))};
        await boxes.receive(box.parcelId,command,"synthetic-status-receiver");
        expect((await boxes.receive(box.parcelId,command,"synthetic-retry")).replayed).toBe(true);
        expect((await read()).get(100)!.returns[0].status.code).toBe(index===0?"partially_received":"received");
      }
      expect((await read()).get(100)!.refunds).toEqual([]);
      expect((await read()).get(100)!.returns[0].refund.code).toBe("not_started");
      expect((await pool.query("SELECT count(*)::int AS n FROM wms.carrier_dispatch_commands")).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int AS n FROM returns.return_case_customer_refunds")).rows[0].n).toBe(0);
      expect(await sourceFacts()).toEqual(immutable);
      expect(carrier.calls.filter(call=>call.method==="POST")).toHaveLength(2);
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivered");
      // Historical evidence is bound to its exact current source revision; a
      // differently bound event cannot complete or damage another package.
      await channelEvidence.append(historicalEvidence.map(event=>({...event,nativeRevision:"f".repeat(64),canonicalStatus:"exception",eventId:"unrelated-revision"})));
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivered");
      await expect(channelEvidence.append([...historicalEvidence,...historicalEvidence.map(event=>({...event,omsOrderId:200}))])).rejects.toThrow("BATCH_MISMATCH");
      await expect(channelEvidence.append(historicalEvidence.map(event=>({...event,externalCustomerId:"902"})))).rejects.toThrow("OWNER_CHANGED");
      await tracking.ingestStatusSnapshot({tracking_number:"SYNTHETIC-OUTBOUND-1",carrier_code:"ups",status_code:"EX",events:[{occurred_at:instant.toISOString(),status_code:"EX"}]},
        {providerLabelId:"901",carrierCode:"ups",trackingNumber:"SYNTHETIC-OUTBOUND-1"});
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivery_issue");
      instant=new Date(instant.getTime()+1000);
      await tracking.ingestStatusSnapshot({tracking_number:"SYNTHETIC-OUTBOUND-1",carrier_code:"ups",status_code:"DE",events:[{occurred_at:instant.toISOString(),status_code:"DE"}]},
        {providerLabelId:"901",carrierCode:"ups",trackingNumber:"SYNTHETIC-OUTBOUND-1"});
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivered");
      expect(nativeRead).toHaveBeenCalledTimes(4);
      for(const invalid of [{...scope,externalCustomerId:"902"},{...scope,channelId:37},{...scope,orders:[{omsOrderId:100,externalOrderId:"2000"},{omsOrderId:200,externalOrderId:"1000"}]}]){
        expect((await deliveryReader.read(invalid,instant)).size).toBe(0);
        expect((await new PostgresCustomerReturnProgressReader(pool).read(invalid,instant)).size).toBe(0);
      }
      await tracking.ingestStatusSnapshot({tracking_number:"SYNTHETIC-OUTBOUND-3",carrier_code:"ups",status_code:"IT",events:[{occurred_at:new Date(instant.getTime()-60000).toISOString(),status_code:"IT"}]},
        {providerLabelId:"903",carrierCode:"ups",trackingNumber:"SYNTHETIC-OUTBOUND-3"});
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivered");
      await tracking.ingestStatusSnapshot({tracking_number:"SYNTHETIC-OUTBOUND-3",carrier_code:"ups",status_code:"EX",events:[{occurred_at:new Date(instant.getTime()+86400000).toISOString(),status_code:"EX"}]},
        {providerLabelId:"903",carrierCode:"ups",trackingNumber:"SYNTHETIC-OUTBOUND-3"});
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("delivered");
      // New native units must prevent a previous delivered package set from
      // claiming the entire revised order was delivered.
      await pool.query("UPDATE wms.order_items SET quantity=quantity+1 WHERE id=(SELECT min(id) FROM wms.order_items)");
      expect((await deliveryReader.read(scope,instant)).get(100)?.delivery?.code).toBe("partially_delivered");
    });

    it("retains the full supported OMS bigint identity without narrowing shipping evidence to 32 bits",async()=>{
      const provider=complexProvider(), omsOrderId=Number.MAX_SAFE_INTEGER;
      await pool.query(`INSERT INTO oms.oms_orders(id,channel_id,external_order_id,external_order_number,external_customer_id,ordered_at)
        OVERRIDING SYSTEM VALUE VALUES($1,36,'1001','#BIGINT-TEST','901',$2)`,[omsOrderId,instant]);
      const evidence=deriveSalesChannelDeliveryEvidence(complexHistory(provider),"901",provider,instant)
        .map(event=>({...event,omsOrderId,externalOrderId:"1001"}));
      await new PostgresSalesChannelDeliveryEvidenceStore(pool).append(evidence);
      expect((await pool.query("SELECT oms_order_id::text AS id FROM wms.sales_channel_delivery_evidence WHERE oms_order_id=$1",[omsOrderId])).rows).toEqual([{id:String(omsOrderId)}]);
    });

    it("fences concurrent status workers and expired leases, retains immutable attempts and stable source identity",async()=>{
      for(let index=1;index<=10;index++)await enqueueSavedLabelStatus(pool,{kind:"history",sourceId:100,providerReference:String(900+index),trackingNumber:`SYNTHETIC-${index}`},instant);
      const store=new PostgresSavedLabelStatusStore(pool);
      const claims=await Promise.all([store.claim(5,instant,"19600000-0000-4000-8000-000000000101"),store.claim(5,instant,"19600000-0000-4000-8000-000000000102")]);
      expect(claims.flat()).toHaveLength(10);expect(new Set(claims.flat().map(c=>c.id)).size).toBe(10);
      expect(await store.claim(1,instant,"19600000-0000-4000-8000-000000000103")).toEqual([]);
      instant=new Date(instant.getTime()+SAVED_LABEL_STATUS_LEASE_MS+1);
      const next=await store.claim(10,instant,"19600000-0000-4000-8000-000000000104");
      expect(next).toHaveLength(10);
      const outcome={state:"complete" as const,status:"delivered",code:null,nextAttemptAt:null};
      expect(await store.settle(claims[0][0],outcome,instant)).toBe(false);
      for(const claim of next)expect(await store.settle(claim,outcome,instant)).toBe(true);
      expect((await pool.query("SELECT count(*)::int AS n FROM wms.saved_label_status_attempts")).rows[0].n).toBe(10);
      await expect(pool.query("UPDATE wms.saved_label_status_attempts SET actor='changed'")).rejects.toThrow(/immutable/);
      await expect(enqueueSavedLabelStatus(pool,{kind:"history",sourceId:100,providerReference:"901",trackingNumber:"ANOTHER-TRACK"},instant)).rejects.toThrow(/IDENTITY_CHANGED/);
    });

    it("never lets historical tracking backlog starve a new return or normal shipment",async()=>{
      await pool.query(`INSERT INTO wms.saved_label_status_jobs(source_kind,source_id,provider_reference,tracking_number,priority,next_attempt_at,created_at,updated_at)
        SELECT 'history',100,n::text,'OLD-'||n,2,$1,$1,$1 FROM generate_series(1,30)n`,[instant]);
      await enqueueSavedLabelStatus(pool,{kind:"history",sourceId:100,providerReference:"901",trackingNumber:"CURRENT-OUTBOUND"},instant);
      await enqueueSavedLabelStatus(pool,{kind:"return",sourceId:1,providerReference:"se-901",trackingNumber:"CURRENT-RETURN"},instant);
      const selected=await new PostgresSavedLabelStatusStore(pool).claim(2,instant,"19600000-0000-4000-8000-000000000105");
      expect(selected.map(c=>c.kind)).toEqual(["return","history"]);expect(selected[1].providerReference).toBe("901");
    });

    it("bootstraps existing successful labels and verified packages idempotently without altering their source records",async()=>{
      const s=await setup(),w=workflow(s);await w.enqueue();await w.worker.run();await w.worker.run();await w.worker.run();
      const history=new PostgresPackageHistoryStore(pool,()=>new Date(instant));
      await history.drain(1000,{orderIds:[100]});
      const [claim]=await history.claim(1,instant,"19600000-0000-4000-8000-000000000106",{orderIds:[100]});
      expect(await history.complete(claim,complexHistory(s.provider),instant)).toBe(true);
      const before=await sourceFacts(),beforeCounts=await counts();
      await pool.query("TRUNCATE wms.saved_label_status_jobs CASCADE");
      const migration=readFileSync("migrations/900000045000019690001_customer_order_progress_capture.sql","utf8");
      const seed=migration.slice(migration.indexOf("-- Existing successful labels"));
      await pool.query(seed);await pool.query(seed);
      const jobs=(await pool.query("SELECT source_kind,priority,count(*)::int AS n FROM wms.saved_label_status_jobs GROUP BY source_kind,priority ORDER BY source_kind")).rows;
      expect(jobs).toEqual([{source_kind:"history",priority:1,n:3},{source_kind:"return",priority:0,n:2}]);
      expect(await sourceFacts()).toEqual(before);expect(await counts()).toEqual(beforeCounts);
    });

    it("uses current replacement-label tracking and refuses ambiguous active labels on the same physical package",async()=>{
      await setup();
      const tracking=new CarrierTrackingService({repository:createDrizzleCarrierTrackingRepository(drizzle(pool)),clock:{now:()=>new Date(instant)},logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn()}});
      const observe=async(reference:string,number:string,voided=false)=>tracking.observeStatusLabel(normalizeSavedLabelStatusObservation(
        {kind:"history",sourceId:100,providerReference:reference,trackingNumber:number},
        {providerReference:reference,trackingNumber:number,carrierCode:"ups",serviceCode:"ups_ground",direction:"outbound",voided,voidedAt:voided?instant.toISOString():null},instant));
      const old=await observe("901","SYNTHETIC-OLD-LABEL"),current=await observe("1901","SYNTHETIC-CURRENT-LABEL");
      for(const label of [old,current])await pool.query(`INSERT INTO wms.shipping_provider_label_links(shipping_provider_label_id,physical_shipment_id,source,created_at)
        VALUES($1,1,'provider_physical_identity',$2)`,[label.shippingProviderLabelId,instant]);
      await observe("901","SYNTHETIC-OLD-LABEL",true);
      await tracking.ingestStatusSnapshot({tracking_number:"SYNTHETIC-CURRENT-LABEL",status_code:"DE",carrier_code:"ups",events:[{occurred_at:instant.toISOString(),status_code:"DE"}]},
        {providerLabelId:"1901",carrierCode:"ups",trackingNumber:"SYNTHETIC-CURRENT-LABEL"});
      const reader=new PostgresCustomerOrderDeliveryReader(pool),scope={channelId:36,externalCustomerId:"901",orders:[{omsOrderId:100,externalOrderId:"1000"}]};
      expect((await reader.read(scope,instant)).get(100)!.packages.find(p=>p.key==="physical:1")).toMatchObject({trackingNumber:"SYNTHETIC-CURRENT-LABEL",status:{code:"delivered"}});
      const ambiguous=await observe("2901","SYNTHETIC-OTHER-ACTIVE-LABEL");
      await pool.query(`INSERT INTO wms.shipping_provider_label_links(shipping_provider_label_id,physical_shipment_id,source,created_at)
        VALUES($1,1,'provider_physical_identity',$2)`,[ambiguous.shippingProviderLabelId,instant]);
      expect((await reader.read(scope,instant)).get(100)!.packages.find(p=>p.key==="physical:1")).toMatchObject({trackingNumber:null,status:{code:"unknown"}});
      expect((await pool.query("SELECT count(*)::int AS n FROM wms.carrier_dispatch_commands")).rows[0].n).toBe(0);
    });

    it("automatically reconciles a lost carrier reply before buying another reviewed box", async () => {
      const s = await setup(), w = workflow(s);
      s.purchase.mockImplementationOnce(async input => {
        s.savedProviderLabels.set(input.externalShipmentId, s.makeLabel(input));
        throw new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown");
      });
      await w.enqueue(); await w.worker.run(); await w.worker.run();
      expect(s.purchase).toHaveBeenCalledTimes(1);
      instant = new Date(instant.getTime() + 5_001);
      await w.worker.run(); await w.worker.run();
      expect((await w.read())?.phase).toBe("ready");
      expect(s.recover).toHaveBeenCalledTimes(1);
      expect(s.purchase).toHaveBeenCalledTimes(2);
    });
    it("stops bounded unresolved purchases with a useful result and resumes reconciliation on the same explicit retry", async () => {
      const s = await setup(), w = workflow(s);
      s.purchase.mockRejectedValueOnce(new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown"));
      await w.enqueue(); await w.worker.run(); await w.worker.run();
      for (let count = 0; count < 8; count++) { instant = new Date(instant.getTime() + 60_001); await w.worker.run(); }
      const stopped = (await w.read())!;
      expect(stopped.phase).toBe("needs_help");
      expect(stopped.reason).toBe("RETURN_LABEL_RECONCILIATION_REQUIRED");
      const count = s.recover.mock.calls.length;
      await w.worker.run(); expect(s.recover).toHaveBeenCalledTimes(count);
      expect(s.purchase).toHaveBeenCalledTimes(1);
      const original = s.purchase.mock.calls[0][0];
      s.savedProviderLabels.set(original.externalShipmentId, s.makeLabel(original));
      await w.store.retryOwned(w.principal, s.input.idempotencyKey, instant);
      await w.worker.run(); await w.worker.run();
      expect((await w.read())?.phase).toBe("ready");
      expect(s.purchase).toHaveBeenCalledTimes(2);
    });
    it("retries a conclusively rejected label only after a new explicit action, preserving failed evidence", async () => {
      const s = await setup(), w = workflow(s);
      s.purchase.mockRejectedValueOnce(new ReturnLabelProviderError("RETURN_LABEL_REJECTED", "rejected"));
      await w.enqueue(); await w.worker.run(); await w.worker.run();
      expect((await w.read())?.phase).toBe("retryable_failure");
      await w.worker.run(); expect(s.purchase).toHaveBeenCalledTimes(1);
      await w.store.retryOwned(w.principal, s.input.idempotencyKey, instant);
      await w.worker.run(); await w.worker.run();
      expect((await w.read())?.phase).toBe("ready");
      expect(s.purchase).toHaveBeenCalledTimes(3);
      expect((await pool.query("SELECT status FROM returns.customer_return_label_attempts ORDER BY id")).rows.map(row => row.status))
        .toEqual(["failed", "succeeded", "succeeded"]);
    });
    it("restores the same server intent through the owned customer boundary and exposes completed labels in history", async () => {
      const s = await setup(), w = workflow(s);
      const access = new CustomerReturnOrderAccessService({ channelId: 36,
        principalReader: { getVerifiedPrincipal: async () => ({ kind: "customer", ...w.principal }) },
        repository: new PostgresCustomerReturnOrderAccessRepository(pool) });
      const operations = new CustomerReturnCustomerOperationsService({ principal: w.principal, orderAccess: access,
        ownership: new PostgresCustomerReturnCustomerOwnershipReader(pool), submissions: s.submission,
        labels: s.labels, workflows: w.store, now: () => new Date(instant) });
      const { channelId: _channel, orderReference: _reference, ...input } = s.input;
      expect((await operations.queueLabels(100, input)).phase).toBe("queued");
      const restored = await operations.orderWorkflow(100);
      expect(restored.input).toEqual(input); expect(s.purchase).not.toHaveBeenCalled();
      await w.worker.run(); await w.worker.run(); await w.worker.run();
      const ready = await operations.workflowStatus(s.input.idempotencyKey);
      expect(ready.phase).toBe("ready");
      expect(ready.labels?.parcels.every(parcel => parcel.downloadPath?.startsWith("/api/returns/customer/returns/"))).toBe(true);
      expect((await operations.listReturns()).returns.map(row => row.authorizationId)).toEqual([ready.labels!.authorizationId]);
      await expect(operations.orderWorkflow(100)).rejects.toMatchObject({ code: "RETURN_WORKFLOW_NOT_FOUND" });
      await operations.queueExistingLabels(ready.labels!.authorizationId); await w.worker.run();
      expect(s.purchase).toHaveBeenCalledTimes(2);
    });
    it("can retry a corrected definitive carrier rejection after several failures without resetting the RMA", async () => {
      const s = await setup(), w = workflow(s);
      s.purchase.mockRejectedValue(new ReturnLabelProviderError("RETURN_LABEL_CREDENTIAL_REJECTED", "rejected"));
      await w.enqueue(); await w.worker.run(); await w.worker.run();
      for (let attempt = 0; attempt < 3; attempt++) {
        await w.store.retryOwned(w.principal, s.input.idempotencyKey, instant); await w.worker.run();
        expect((await w.read())?.phase).toBe("retryable_failure");
      }
      expect(s.purchase).toHaveBeenCalledTimes(4);
      s.purchase.mockImplementation(async input => { const label = s.makeLabel(input); s.savedProviderLabels.set(input.externalShipmentId, label); return label; });
      await w.store.retryOwned(w.principal, s.input.idempotencyKey, instant); await w.worker.run(); await w.worker.run();
      expect((await w.read())?.phase).toBe("ready"); expect(s.purchase).toHaveBeenCalledTimes(6);
      expect((await pool.query("SELECT count(*)::int AS count FROM returns.customer_return_authorizations")).rows[0].count).toBe(1);
    });
    it("fences stale worker completion, changed intent, and changed customer ownership", async () => {
      const s = await setup(), w = workflow(s);
      await w.enqueue();
      await expect(w.store.enqueue({ request: { ...s.input, parcels: [...s.input.parcels].reverse() }, scope: COMPLEX_SCOPE,
        actor: "customer:36:901", now: instant })).rejects.toMatchObject({ code: "RETURN_LABEL_COMMAND_CONFLICT" });
      const [leased] = await w.store.claim(1, "19600000-0000-4000-8000-000000000099", instant);
      instant = new Date(instant.getTime() + RETURN_WORKFLOW_LEASE_MS + 1);
      await w.store.claim(1, "19600000-0000-4000-8000-000000000098", instant);
      expect(await w.store.settle(leased, { phase: "retryable_failure", reason: "RETURN_WORKFLOW_TEMPORARY_FAILURE",
        authorizationId: null, failures: 1, nextRunAt: instant, errorCode: "RETURN_TEST_FAILURE" }, instant)).toBe(false);
      await pool.query("UPDATE oms.oms_orders SET external_customer_id='902' WHERE id=100");
      expect(await w.read()).toBeNull();
      instant = new Date(instant.getTime() + RETURN_WORKFLOW_LEASE_MS + 1);
      await w.worker.run(); expect(s.purchase).not.toHaveBeenCalled();
      expect((await pool.query("SELECT phase,last_error_code FROM returns.customer_return_workflows")).rows[0])
        .toEqual({ phase: "needs_help", last_error_code: "RETURN_WORKFLOW_OWNER_CHANGED" });
    });

    async function counts() {
      return (
        await pool.query(`SELECT
      (SELECT count(*)::int FROM returns.customer_return_authorizations) AS authorizations,
      (SELECT count(*)::int FROM returns.return_cases) AS cases,
      (SELECT count(*)::int FROM returns.customer_return_parcels) AS parcels,
      (SELECT count(*)::int FROM returns.customer_return_label_attempts) AS attempts,
      (SELECT count(*)::int FROM inventory.inventory_transactions) AS inventory,
      (SELECT count(*)::int FROM returns.return_case_customer_refunds) AS refunds`)
      ).rows[0];
    }
    async function sourceFacts() {
      return (
        await pool.query(`SELECT jsonb_build_object(
      'orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM oms.oms_orders o),
      'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM oms.oms_order_lines l),
      'warehouse',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM wms.orders w),
      'warehouseItems',(SELECT jsonb_agg(to_jsonb(wi) ORDER BY id) FROM wms.order_items wi),
      'shipments',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM wms.physical_shipments s)) AS facts`)
      ).rows[0].facts;
    }

    it("accepts purchased items with no original warehouse orders, shipments or fulfillment and receives both mixed boxes once", async () => {
      const s = await setup();
      await pool.query(
        "TRUNCATE wms.orders,wms.physical_shipments RESTART IDENTITY CASCADE",
      );
      s.provider.fulfillments = [];
      const before = await sourceFacts();
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.local.wmsItems).toHaveLength(0);
      expect(fresh.order.lines.map((line) => line.eligibleQuantity)).toEqual([
        9, 6, 3, 1, 0,
      ]);
      const request = complexRequest(fresh, 1);
      const accepted = await s.submission.submitForOrder(
        request,
        "customer",
        COMPLEX_SCOPE,
      );
      expect(
        (await s.submission.submitForOrder(request, "retry", COMPLEX_SCOPE))
          .authorizationId,
      ).toBe(accepted.authorizationId);
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      expect(s.purchase).toHaveBeenCalledTimes(2);
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      for (const parcel of [...ready.parcels].reverse()) {
        const box = await boxes.lookup(parcel.trackingNumber!);
        const command = {
          idempotencyKey: `19380000-0000-4000-8000-${String(80 + box.boxNumber).padStart(12, "0")}`,
          notes: null,
          lines: box.lines.map((line) => ({
            authorizationLineId: line.authorizationLineId,
            expectedCurrentReceivedQuantity: 0,
            quantityReceivedNow: line.expectedQuantity,
          })),
        };
        expect(
          (await boxes.receive(box.parcelId, command, "receiver")).caseIds,
        ).toHaveLength(1);
        expect(
          (await boxes.receive(box.parcelId, command, "retry")).replayed,
        ).toBe(true);
      }
      const caseId = Number(
        (await pool.query("SELECT id FROM returns.return_cases")).rows[0].id,
      );
      const operations = new ReturnCaseOperationService(
        new PostgresReturnCaseOperationStore(),
        () => new Date(instant),
      );
      const base = { caseId, actor: "receiver", notes: null };
      const started = await operations.startInspection({
        ...base,
        idempotencyKey: "native-start-inspection",
      });
      expect(
        (
          await operations.startInspection({
            ...base,
            idempotencyKey: "native-start-inspection",
          })
        ).replayed,
      ).toBe(true);
      const completion = {
        ...base,
        idempotencyKey: "native-complete-inspection",
        inspectionId: started.inspectionId,
        outcome: "approved" as const,
      };
      await operations.completeInspection(completion);
      expect((await operations.completeInspection(completion)).replayed).toBe(
        true,
      );
      const caseItems = (
        await pool.query(
          "SELECT id,quantity FROM returns.return_case_items ORDER BY id",
        )
      ).rows;
      const disposition = {
        ...base,
        idempotencyKey: "native-record-disposition",
        inspectionId: started.inspectionId,
        lines: caseItems.map((item) => ({
          returnCaseItemId: Number(item.id),
          quantity: Number(item.quantity),
          treatment: "hold_non_sellable" as const,
          expectedCurrentReceivedQuantity: Number(item.quantity),
          expectedCurrentDisposedQuantity: 0,
        })),
      };
      await operations.recordDisposition(disposition);
      expect((await operations.recordDisposition(disposition)).replayed).toBe(
        true,
      );
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS units FROM wms.return_items",
          )
        ).rows[0].units,
      ).toBe(13);
      expect(
        (
          await pool.query(
            "SELECT order_id,source_authorization_id FROM wms.returns",
          )
        ).rows,
      ).toEqual([
        {
          order_id: null,
          source_authorization_id: String(accepted.authorizationId),
        },
      ]);
      expect(
        (
          await pool.query(
            "SELECT wms_order_id,unit_paid_price_cents,source_line_total_cents FROM returns.return_case_items ci JOIN returns.return_cases rc ON rc.id=ci.return_case_id",
          )
        ).rows.every(
          (row) =>
            row.wms_order_id === null &&
            row.unit_paid_price_cents === null &&
            row.source_line_total_cents === null,
        ),
      ).toBe(true);
      expect(
        (await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE)).order.lines.map(
          (line) => line.eligibleQuantity,
        ),
      ).toEqual([3, 2, 1, 0, 0]);
      expect(await sourceFacts()).toEqual(before);
      expect(await counts()).toMatchObject({
        authorizations: 1,
        cases: 1,
        attempts: 2,
        refunds: 0,
        inventory: 0,
      });
    });

    it("counts a prior return by purchased line even if its optional original warehouse identity later disagrees", async () => {
      const s = await setup();
      const authorization = new PostgresCustomerReturnAuthorizationStore(
        drizzle(pool, { schema }),
      );
      await authorization.transaction(async (tx) => {
        await tx.lockCommand({
          channelId: 36,
          idempotencyKey: "legacy-native-purchase-test",
        });
        await tx.lockSource({
          channelId: 36,
          omsOrderId: 100,
          omsOrderLineIds: [101],
        });
        await tx.persist({
          channelId: 36,
          omsOrderId: 100,
          idempotencyKey: "legacy-native-purchase-test",
          semanticHash: "a".repeat(64),
          eligibilityRevision: "b".repeat(64),
          actor: "test",
          now: instant,
          policySnapshot: {},
          warehouseSnapshot: {},
          lines: [
            {
              omsOrderLineId: 101,
              externalLineItemId: "500",
              quantity: 1,
              reasonCode: null,
              allocations: [
                {
                  wmsOrderItemId: 301,
                  fulfillmentId: "601",
                  fulfillmentLineItemId: "1101",
                  quantity: 1,
                  originalQuantity: 3,
                  eligibleQuantity: 3,
                  deliveryEvidence: {},
                },
              ],
            },
          ],
        });
      });
      await pool.query(
        "UPDATE wms.order_items SET shopify_line_item_id='501' WHERE id=301",
      );
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines[0]).toMatchObject({
        eligibleQuantity: 8,
        alreadyReturningQuantity: 1,
      });
      await expect(
        s.submission.submitForOrder(
          complexRequest(fresh, 1),
          "customer",
          COMPLEX_SCOPE,
        ),
      ).resolves.toHaveProperty("authorizationId");
      expect(
        (
          await pool.query(
            "SELECT sum(quantity)::int AS units FROM returns.customer_return_authorization_lines WHERE oms_order_line_id=101",
          )
        ).rows[0].units,
      ).toBe(7);
      expect(await counts()).toMatchObject({
        authorizations: 2,
        cases: 1,
        refunds: 0,
        inventory: 0,
      });
    });

    it("deducts exact legacy physical returns without turning them into a global history warning", async () => {
      const s = await setup();
      await pool.query(
        `INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,created_at)
        VALUES('return',1,201,301,$1)`,
        [INTAKE_NOW],
      );
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines[0]).toMatchObject({
        eligibleQuantity: 8,
        alreadyReturningQuantity: 1,
      });
      await expect(
        s.submission.submitForOrder(
          complexRequest(fresh, 1),
          "customer",
          COMPLEX_SCOPE,
        ),
      ).resolves.toHaveProperty("authorizationId");
      expect(
        (await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE)).order.lines[0],
      ).toMatchObject({ eligibleQuantity: 2, alreadyReturningQuantity: 7 });
      expect((await counts()).inventory).toBe(1);
    });

    it("quotes and persists measured mixed-box weights for purchased items with missing catalog measurements", async () => {
      const s = await setup();
      await pool.query(
        "UPDATE catalog.product_variants SET weight_grams=NULL WHERE id=601",
      );
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines[0]).toMatchObject({
        eligibleQuantity: 9,
        unitWeightGrams: null,
        message: null,
      });
      const selected = complexRequest(fresh, 1);
      const request = {
        ...selected,
        parcels: selected.parcels.map((parcel, index) => ({
          ...parcel,
          packedWeightGrams: index === 0 ? 1800 : 1900,
        })),
      };
      const {
        idempotencyKey: _key,
        settingsVersion: _settings,
        ...review
      } = request;
      expect(
        (await s.live.reviewCanonical(review, COMPLEX_SCOPE)).parcels.map(
          (parcel) => parcel.weightGrams,
        ),
      ).toEqual([1800, 1900]);
      const accepted = await s.submission.submitForOrder(
        request,
        "customer",
        COMPLEX_SCOPE,
      );
      expect(
        (await s.submission.submitForOrder(request, "retry", COMPLEX_SCOPE))
          .authorizationId,
      ).toBe(accepted.authorizationId);
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      expect(ready.parcels.every((parcel) => parcel.status === "ready")).toBe(
        true,
      );
      expect(s.purchase).toHaveBeenCalledTimes(2);
      expect(
        (
          await pool.query(
            "SELECT weight_grams FROM returns.customer_return_parcels ORDER BY id",
          )
        ).rows.map((row) => Number(row.weight_grams)),
      ).toEqual([1800, 1900]);
      expect(await counts()).toMatchObject({
        authorizations: 1,
        cases: 1,
        inventory: 0,
        refunds: 0,
      });
    });

    it("completes repacking, durable submission, two labels, timeout recovery and out-of-order receipts without money or inventory writes", async () => {
      const s = await setup();
      const before = await sourceFacts();
      expect(
        s.inspection.order.lines.map((line) => line.eligibleQuantity),
      ).toEqual([9, 6, 3, 1, 0]);
      expect(s.inspection.local.fulfillmentBindings).toHaveLength(10);
      const status = await s.submission.submitForOrder(
        s.input,
        "synthetic-customer",
        COMPLEX_SCOPE,
      );
      expect(status.parcels).toHaveLength(2);
      expect(await counts()).toEqual({
        authorizations: 1,
        cases: 1,
        parcels: 2,
        attempts: 0,
        inventory: 0,
        refunds: 0,
      });
      const allocations = (
        await pool.query(`SELECT al.oms_order_line_id,a.source_kind,a.wms_order_item_id,a.fulfillment_id,a.fulfillment_line_item_id,a.quantity
        FROM returns.customer_return_authorization_allocations a JOIN returns.customer_return_authorization_lines al ON al.id=a.authorization_line_id ORDER BY al.oms_order_line_id`)
      ).rows;
      expect(
        allocations.map((row) => [
          Number(row.oms_order_line_id),
          Number(row.quantity),
        ]),
      ).toEqual([
        [101, 6],
        [102, 4],
        [104, 2],
        [105, 1],
      ]);
      expect(
        allocations.every(
          (row) =>
            row.source_kind === "shopify_purchase" &&
            row.wms_order_item_id === null &&
            row.fulfillment_id === null &&
            row.fulfillment_line_item_id === null,
        ),
      ).toBe(true);
      const parcels = (
        await pool.query(`SELECT p.parcel_key,l.oms_order_line_id,i.quantity FROM returns.customer_return_parcel_items i
      JOIN returns.customer_return_parcels p ON p.id=i.parcel_id JOIN returns.customer_return_authorization_lines l ON l.id=i.authorization_line_id
      ORDER BY p.parcel_key,l.oms_order_line_id`)
      ).rows;
      expect(
        parcels.map((row) => [
          row.parcel_key,
          Number(row.oms_order_line_id),
          Number(row.quantity),
        ]),
      ).toEqual([
        ["1", 101, 4],
        ["1", 102, 1],
        ["1", 104, 1],
        ["2", 101, 2],
        ["2", 102, 3],
        ["2", 104, 1],
        ["2", 105, 1],
      ]);
      // The client retry and an accepted replay must not reserve any units again.
      expect(
        (
          await s.submission.resumeForOrder(
            36,
            COMPLEX_KEY,
            "retry",
            COMPLEX_SCOPE,
          )
        ).authorizationId,
      ).toBe(status.authorizationId);
      expect(
        (await s.submission.submitForOrder(s.input, "retry", COMPLEX_SCOPE))
          .authorizationId,
      ).toBe(status.authorizationId);
      expect(
        (await s.labels.progress(36, status.authorizationId, "customer"))
          .parcels[0].status,
      ).toBe("ready");
      s.purchase.mockImplementationOnce(async (input) => {
        s.savedProviderLabels.set(input.externalShipmentId, s.makeLabel(input));
        throw new ReturnLabelProviderError("RETURN_LABEL_TIMEOUT", "unknown");
      });
      expect(
        (
          await s.labels.progress(36, status.authorizationId, "customer")
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "needs_review"]);
      s.recover.mockResolvedValueOnce(null);
      expect(
        (
          await s.labels.progress(36, status.authorizationId, "retry")
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "needs_review"]);
      expect(s.purchase).toHaveBeenCalledTimes(2);
      expect(
        (
          await s.labels.progress(36, status.authorizationId, "retry")
        ).parcels.map((parcel) => parcel.status),
      ).toEqual(["ready", "ready"]);
      await s.labels.progress(36, status.authorizationId, "retry");
      expect(s.purchase).toHaveBeenCalledTimes(2);
      expect(s.recover).toHaveBeenCalledTimes(2);
      for (const parcel of status.parcels)
        expect(
          (await s.labels.artifact(36, status.authorizationId, parcel.parcelId))
            .labelFormat,
        ).toBe("pdf");
      expect(
        (await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE)).order.lines.map(
          (line) => line.eligibleQuantity,
        ),
      ).toEqual([3, 2, 1, 0, 0]);

      const ready = await s.labels.status(36, status.authorizationId);
      // A scan locates the exact repacked parcel, not every case under its RMA.
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      const box2 = await boxes.lookup(ready.parcels[1].trackingNumber!);
      expect(box2.boxNumber).toBe(2);
      expect(box2.lines.map((line) => line.expectedQuantity)).toEqual([
        2, 3, 1, 1,
      ]);
      const receipt2 = {
        idempotencyKey: "19380000-0000-4000-8000-000000000021",
        notes: "Second box arrives first",
        lines: box2.lines.map((line) => ({
          authorizationLineId: line.authorizationLineId,
          expectedCurrentReceivedQuantity: 0,
          quantityReceivedNow: line.expectedQuantity,
        })),
      };
      const second = await boxes.receive(
        box2.parcelId,
        receipt2,
        "synthetic-receiver",
      );
      expect(second.caseIds).toHaveLength(1);
      expect(
        (await boxes.receive(box2.parcelId, receipt2, "retry")).replayed,
      ).toBe(true);
      expect(
        (await boxes.lookup(ready.parcels[1].trackingNumber!)).lines.every(
          (line) => line.receivedQuantity === line.expectedQuantity,
        ),
      ).toBe(true);
      const box1 = await boxes.lookup(ready.parcels[0].trackingNumber!);
      expect(box1.lines.every((line) => line.receivedQuantity === 0)).toBe(
        true,
      );
      await boxes.receive(
        box1.parcelId,
        {
          ...receipt2,
          idempotencyKey: "19380000-0000-4000-8000-000000000022",
          lines: box1.lines.map((line) => ({
            authorizationLineId: line.authorizationLineId,
            expectedCurrentReceivedQuantity: 0,
            quantityReceivedNow: line.expectedQuantity,
          })),
        },
        "synthetic-receiver",
      );
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS units FROM wms.return_items",
          )
        ).rows[0].units,
      ).toBe(13);
      expect(await counts()).toEqual({
        authorizations: 1,
        cases: 1,
        parcels: 2,
        attempts: 2,
        inventory: 0,
        refunds: 0,
      });
      expect(await sourceFacts()).toEqual(before);
    });

    it.each([false, true])(
      "keeps the remaining purchased units available independently of delivery updates (historical=%s)",
      async (legacy) => {
        const s = await setup(legacy);
        await s.submission.submitForOrder(s.input, "first", COMPLEX_SCOPE);
        const third = s.provider.fulfillments[2];
        third.deliveredAt = "2026-09-25T12:00:00.000Z";
        third.displayStatus = "DELIVERED";
        const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
        expect(fresh.order.lines.map((line) => line.eligibleQuantity)).toEqual([
          3, 2, 1, 0, 0,
        ]);
        const selections = fresh.order.lines
          .filter((line) => line.eligibleQuantity > 0)
          .map((line) => ({
            lineId: line.id,
            quantity: line.eligibleQuantity,
            reasonCode: null,
          }));
        const accepted = await s.submission.submitForOrder(
          {
            ...s.input,
            idempotencyKey: otherKey,
            sourceRevision: fresh.order.sourceRevision,
            selections,
            parcels: [
              {
                dimensions: s.input.parcels[0].dimensions,
                originalBoxId: null,
                items: selections.map(({ lineId, quantity }) => ({
                  lineId,
                  quantity,
                })),
              },
            ],
          },
          "second",
          COMPLEX_SCOPE,
        );
        expect(accepted.parcels).toHaveLength(1);
        expect((await counts()).authorizations).toBe(2);
        expect(
          (
            await pool.query(
              "SELECT sum(quantity)::int AS units FROM returns.customer_return_authorization_allocations",
            )
          ).rows[0].units,
        ).toBe(19);
      },
    );

    it("keeps a money-only refund separate from delivered return quantities", async () => {
      const s = await setup();
      s.provider.refunds = [
        {
          id: "gid://shopify/Refund/800",
          updatedAt: INTAKE_NOW.toISOString(),
          returnId: null,
          lines: [],
        },
      ];
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines.map((line) => line.eligibleQuantity)).toEqual([
        9, 6, 3, 1, 0,
      ]);
      await s.submission.submitForOrder(
        complexRequest(fresh, 1),
        "synthetic-customer",
        COMPLEX_SCOPE,
      );
      expect((await counts()).refunds).toBe(0);
    });

    it("subtracts an existing native return without losing the remaining repackable units", async () => {
      const s = await setup();
      s.provider.returns = [
        {
          id: "gid://shopify/Return/800",
          status: "OPEN",
          totalQuantity: 1,
          lines: [
            {
              id: "gid://shopify/ReturnLineItem/801",
              fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/1101",
              lineItemId: "gid://shopify/LineItem/500",
              quantity: 1,
              processedQuantity: 0,
              refundedQuantity: 0,
            },
          ],
        },
      ];
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines.map((line) => line.eligibleQuantity)).toEqual([
        8, 6, 3, 1, 0,
      ]);
      const input = complexRequest(fresh, 1);
      input.selections[0].quantity = 5;
      input.parcels[0].items[0].quantity = 3;
      await s.submission.submitForOrder(
        input,
        "synthetic-customer",
        COMPLEX_SCOPE,
      );
      expect(
        (
          await pool.query(
            "SELECT sum(quantity)::int AS units FROM returns.customer_return_authorization_allocations",
          )
        ).rows[0].units,
      ).toBe(12);
      expect(
        (await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE)).order.lines.map(
          (line) => line.eligibleQuantity,
        ),
      ).toEqual([3, 2, 1, 0, 0]);
    });

    it("recovers an accepted intake after losing its response without creating another return", async () => {
      const s = await setup();
      const status = vi.spyOn(s.labels, "status");
      status.mockRejectedValueOnce(
        new Error("Synthetic connection lost after commit"),
      );
      await expect(
        s.submission.submitForOrder(
          s.input,
          "synthetic-customer",
          COMPLEX_SCOPE,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_PROCESSING" });
      expect(
        (
          await s.submission.resumeForOrder(
            36,
            COMPLEX_KEY,
            "reload",
            COMPLEX_SCOPE,
          )
        ).parcels,
      ).toHaveLength(2);
      expect(await counts()).toEqual({
        authorizations: 1,
        cases: 1,
        parcels: 2,
        attempts: 0,
        inventory: 0,
        refunds: 0,
      });
    });

    it("serializes competing command IDs so only one return can claim the same purchased units", async () => {
      const s = await setup();
      const results = await Promise.allSettled([
        s.submission.submitForOrder(s.input, "first", COMPLEX_SCOPE),
        s.submission.submitForOrder(
          { ...s.input, idempotencyKey: otherKey },
          "competing",
          COMPLEX_SCOPE,
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await counts()).authorizations).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT sum(quantity)::int AS units FROM returns.customer_return_authorization_allocations",
          )
        ).rows[0].units,
      ).toBe(13);
    });

    it("completes native historical returns through mixed-box receiving without rewriting outbound evidence", async () => {
      const s = await setup(true);
      const before = await sourceFacts();
      expect(s.inspection.order.boxOptions).toHaveLength(3);
      expect(
        s.inspection.order.lines.map((line) => line.eligibleQuantity),
      ).toEqual([9, 6, 3, 1, 0]);
      expect(s.inspection.local.wmsItems).toHaveLength(10);
      const {
        idempotencyKey: _key,
        settingsVersion: _settings,
        ...reviewInput
      } = s.input;
      expect(
        (await s.live.reviewCanonical(reviewInput, COMPLEX_SCOPE)).parcels,
      ).toHaveLength(2);
      const accepted = await s.submission.submitForOrder(
        s.input,
        "synthetic-customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(
        36,
        accepted.authorizationId,
        "synthetic-customer",
      );
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "synthetic-customer",
      );
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      for (const parcel of [...ready.parcels].reverse()) {
        const box = await boxes.lookup(parcel.trackingNumber!);
        const command = {
          idempotencyKey: `19380000-0000-4000-8000-${String(box.boxNumber).padStart(12, "0")}`,
          notes: null,
          lines: box.lines.map((line) => ({
            authorizationLineId: line.authorizationLineId,
            expectedCurrentReceivedQuantity: 0,
            quantityReceivedNow: line.expectedQuantity,
          })),
        };
        await boxes.receive(box.parcelId, command, "synthetic-receiver");
        expect(
          (await boxes.receive(box.parcelId, command, "retry")).replayed,
        ).toBe(true);
      }
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS units FROM wms.return_items",
          )
        ).rows[0].units,
      ).toBe(13);
      expect(await sourceFacts()).toEqual(before);
      expect(await counts()).toMatchObject({
        authorizations: 1,
        parcels: 2,
        attempts: 2,
        inventory: 0,
        refunds: 0,
      });
    });

    it("receives partial mixed boxes once after a lost response and rejects stale or conflicting retries", async () => {
      const s = await setup();
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      const store = new PostgresReturnParcelReceivingStore();
      const boxes = new ReturnParcelReceivingService(
        store,
        () => new Date(instant),
      );
      const box = await boxes.lookup(ready.parcels[1].trackingNumber!);
      const command = {
        idempotencyKey: "19380000-0000-4000-8000-000000000031",
        notes: null,
        lines: box.lines.map((line) => ({
          authorizationLineId: line.authorizationLineId,
          expectedCurrentReceivedQuantity: 0,
          quantityReceivedNow: 1,
        })),
      };
      const lost = new ReturnParcelReceivingService(
        {
          lookupLabel: (value) => store.lookupLabel(value),
          transaction: async (work) => {
            await store.transaction(work);
            throw new Error("Synthetic lost receipt response after commit");
          },
        },
        () => new Date(instant),
      );
      await expect(
        lost.receive(box.parcelId, command, "receiver"),
      ).rejects.toThrow("Synthetic lost receipt response after commit");
      expect(
        (await boxes.receive(box.parcelId, command, "retry")).replayed,
      ).toBe(true);
      expect(
        (await boxes.lookup(ready.parcels[1].trackingNumber!)).lines.map(
          (line) => line.receivedQuantity,
        ),
      ).toEqual([1, 1, 1, 1]);
      await expect(
        boxes.receive(
          box.parcelId,
          {
            ...command,
            lines: [{ ...command.lines[0], quantityReceivedNow: 2 }],
          },
          "retry",
        ),
      ).rejects.toMatchObject({
        code: "RETURN_PARCEL_RECEIPT_COMMAND_CONFLICT",
      });
      await expect(
        boxes.receive(
          box.parcelId,
          { ...command, idempotencyKey: otherKey },
          "stale",
        ),
      ).rejects.toMatchObject({ code: "RETURN_PARCEL_RECEIPT_STALE" });
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM returns.customer_return_parcel_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
      const box1 = await boxes.lookup(ready.parcels[0].trackingNumber!);
      await expect(
        boxes.receive(
          box1.parcelId,
          { ...command, idempotencyKey: otherKey, lines: [command.lines[3]] },
          "wrong-box",
        ),
      ).rejects.toMatchObject({
        code: "RETURN_PARCEL_RECEIPT_QUANTITY_INVALID",
      });
    });

    it("commits no mixed-box receipt when its receiving case is closed, then retries safely", async () => {
      const s = await setup();
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      const box = await boxes.lookup(ready.parcels[1].trackingNumber!);
      const command = {
        idempotencyKey: "19380000-0000-4000-8000-000000000032",
        notes: null,
        lines: box.lines.map((line) => ({
          authorizationLineId: line.authorizationLineId,
          expectedCurrentReceivedQuantity: 0,
          quantityReceivedNow: line.expectedQuantity,
        })),
      };
      const last = (
        await pool.query("SELECT max(id) AS id FROM returns.return_cases")
      ).rows[0].id;
      await pool.query(
        "UPDATE returns.return_cases SET case_status='closed' WHERE id=$1",
        [last],
      );
      await expect(
        boxes.receive(box.parcelId, command, "receiver"),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS n FROM wms.return_items",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM returns.return_case_commands",
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM returns.customer_return_parcel_receipts",
          )
        ).rows[0].n,
      ).toBe(0);
      await pool.query(
        "UPDATE returns.return_cases SET case_status='open' WHERE id=$1",
        [last],
      );
      expect(
        (
          await boxes.receive(box.parcelId, command, "retry")
        ).parcel.lines.every(
          (line) => line.receivedQuantity === line.expectedQuantity,
        ),
      ).toBe(true);
    });

    it("serializes competing label receipts and rejects ambiguous or unknown tracking identities", async () => {
      const s = await setup();
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      await expect(boxes.lookup("not-a-return-label")).rejects.toMatchObject({
        code: "RETURN_PARCEL_LABEL_NOT_FOUND",
      });
      const box = await boxes.lookup(ready.parcels[1].trackingNumber!);
      const command = {
        idempotencyKey: "19380000-0000-4000-8000-000000000033",
        notes: null,
        lines: box.lines.map((line) => ({
          authorizationLineId: line.authorizationLineId,
          expectedCurrentReceivedQuantity: 0,
          quantityReceivedNow: line.expectedQuantity,
        })),
      };
      const results = await Promise.allSettled([
        boxes.receive(box.parcelId, command, "first"),
        boxes.receive(
          box.parcelId,
          { ...command, idempotencyKey: otherKey },
          "second",
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS n FROM wms.return_items",
          )
        ).rows[0].n,
      ).toBe(7);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM returns.customer_return_parcel_receipts",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it("receives two mixed boxes concurrently without allocating any unit twice", async () => {
      const s = await setup();
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      const manifests = await Promise.all(
        ready.parcels.map((parcel) => boxes.lookup(parcel.trackingNumber!)),
      );
      const results = await Promise.all(
        manifests.map((box) =>
          boxes.receive(
            box.parcelId,
            {
              idempotencyKey: `19380000-0000-4000-8000-${String(60 + box.boxNumber).padStart(12, "0")}`,
              notes: null,
              lines: box.lines.map((line) => ({
                authorizationLineId: line.authorizationLineId,
                expectedCurrentReceivedQuantity: 0,
                quantityReceivedNow: line.expectedQuantity,
              })),
            },
            "receiver",
          ),
        ),
      );
      expect(results).toHaveLength(2);
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS units FROM wms.return_items",
          )
        ).rows[0].units,
      ).toBe(13);
      expect(
        (
          await pool.query(
            "SELECT sum(quantity)::int AS units FROM returns.customer_return_parcel_receipt_allocations",
          )
        ).rows[0].units,
      ).toBe(13);
    });

    it("refuses to pick a box when a carrier reuses the same tracking identity", async () => {
      const s = await setup();
      s.purchase.mockImplementation(async (input) => ({
        ...s.makeLabel(input),
        trackingNumber: "SYNTHETIC-DUPLICATE-TRACKING",
      }));
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      await expect(
        boxes.lookup("SYNTHETIC-DUPLICATE-TRACKING"),
      ).rejects.toMatchObject({ code: "RETURN_PARCEL_LABEL_AMBIGUOUS" });
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS units FROM wms.return_items",
          )
        ).rows[0].units,
      ).toBe(0);
    });

    it("does not guess a box after quantities have been manually received against a case", async () => {
      const s = await setup();
      const accepted = await s.submission.submitForOrder(
        s.input,
        "customer",
        COMPLEX_SCOPE,
      );
      await s.labels.progress(36, accepted.authorizationId, "customer");
      const ready = await s.labels.progress(
        36,
        accepted.authorizationId,
        "customer",
      );
      const row = (
        await pool.query(
          "SELECT id,return_case_id FROM returns.return_case_items ORDER BY id LIMIT 1",
        )
      ).rows[0];
      const operations = new ReturnCaseOperationService(
        new PostgresReturnCaseOperationStore(),
        () => new Date(instant),
      );
      await operations.recordReceipt({
        caseId: Number(row.return_case_id),
        idempotencyKey: "manual-legacy-receipt",
        actor: "receiver",
        notes: null,
        lines: [
          {
            returnCaseItemId: Number(row.id),
            expectedCurrentReceivedQuantity: 0,
            quantityReceivedNow: 1,
          },
        ],
      });
      const boxes = new ReturnParcelReceivingService(
        new PostgresReturnParcelReceivingStore(),
        () => new Date(instant),
      );
      const box = await boxes.lookup(ready.parcels[0].trackingNumber!);
      await expect(
        boxes.receive(
          box.parcelId,
          {
            idempotencyKey: otherKey,
            notes: null,
            lines: [
              {
                authorizationLineId: box.lines[0].authorizationLineId,
                expectedCurrentReceivedQuantity: 0,
                quantityReceivedNow: 1,
              },
            ],
          },
          "receiver",
        ),
      ).rejects.toMatchObject({
        code: "RETURN_PARCEL_RECEIPT_RECONCILIATION_REQUIRED",
      });
      expect(
        (
          await pool.query(
            "SELECT sum(received_qty)::int AS n FROM wms.return_items",
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it.each(["channel", "line", "quantity", "duplicate-order"])(
      "does not let conflicting optional warehouse %s evidence deny a verified Shopify purchase",
      async (change) => {
        const s = await setup(true);
        if (change === "channel")
          await pool.query("UPDATE wms.orders SET channel_id=37 WHERE id=201");
        if (change === "line")
          await pool.query(
            "UPDATE wms.order_items SET shopify_line_item_id='501' WHERE id=301",
          );
        if (change === "quantity")
          await pool.query(
            "UPDATE wms.order_items SET fulfilled_quantity=2 WHERE id=301",
          );
        if (change === "duplicate-order")
          await pool.query(`INSERT INTO oms.oms_orders(channel_id,external_order_id,external_order_number,ordered_at,ship_to_country)
        VALUES(36,'gid://shopify/Order/1000','#DUPLICATE-SYNTHETIC','2026-09-01T12:00:00','US')`);
        const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
        expect(fresh.order.lines[0].eligibleQuantity).toBe(9);
        expect(await counts()).toMatchObject({
          authorizations: 0,
          attempts: 0,
        });
      },
    );

    it("keeps missing warehouse identities out of selection and review readiness", async () => {
      const s = await setup(true);
      await pool.query(
        "UPDATE wms.order_items SET shopify_line_item_id=NULL WHERE id=301",
      );
      const fresh = await s.live.inspectCanonicalForIntake(COMPLEX_SCOPE);
      expect(fresh.order.lines[0]).toMatchObject({
        eligibleQuantity: 9,
        message: null,
      });
      const {
        idempotencyKey: _key,
        settingsVersion: _settings,
        ...review
      } = complexRequest(fresh, 1);
      await expect(
        s.live.reviewCanonical(review, COMPLEX_SCOPE),
      ).resolves.toMatchObject({ effects: "none" });
      expect(await counts()).toMatchObject({ authorizations: 0, attempts: 0 });
    });

    it("resolves simultaneous duplicate submissions into one durable return", async () => {
      const s = await setup();
      const results = await Promise.allSettled([
        s.submission.submitForOrder(s.input, "click1", COMPLEX_SCOPE),
        s.submission.submitForOrder(s.input, "click2", COMPLEX_SCOPE),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      const saved = await s.submission.resumeForOrder(
        36,
        COMPLEX_KEY,
        "reload",
        COMPLEX_SCOPE,
      );
      expect(saved.parcels).toHaveLength(2);
      expect(await counts()).toEqual({
        authorizations: 1,
        cases: 1,
        parcels: 2,
        attempts: 0,
        inventory: 0,
        refunds: 0,
      });
    });

    it.each([
      "excess-purchased-quantity",
      "wrong-purchased-line",
      "missing-box-units",
      "duplicated-box-units",
    ] as const)(
      "blocks %s without creating an RMA or buying postage",
      async (kind) => {
        const s = await setup();
        const request: CustomerReturnLabelSubmitInput = structuredClone(
          s.input,
        );
        if (kind === "excess-purchased-quantity") {
          request.selections[0].quantity = 10;
          request.parcels[0].items[0].quantity = 8;
        }
        if (kind === "wrong-purchased-line")
          request.parcels[1].items[3].lineId = request.selections[0].lineId;
        if (kind === "missing-box-units")
          request.parcels[0].items[0].quantity--;
        if (kind === "duplicated-box-units")
          request.parcels[0].items.push({ ...request.parcels[0].items[0] });
        await expect(
          s.submission.submitForOrder(
            request,
            "synthetic-customer",
            COMPLEX_SCOPE,
          ),
        ).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_REJECTED" });
        expect(await counts()).toEqual({
          authorizations: 0,
          cases: 0,
          parcels: 0,
          attempts: 0,
          inventory: 0,
          refunds: 0,
        });
        expect(s.purchase).not.toHaveBeenCalled();
      },
    );

    it("does not let a different command spend quantities already committed by the first return", async () => {
      const s = await setup();
      await s.submission.submitForOrder(s.input, "first", COMPLEX_SCOPE);
      await expect(
        s.submission.submitForOrder(
          { ...s.input, idempotencyKey: otherKey },
          "second",
          COMPLEX_SCOPE,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_REJECTED" });
      expect((await counts()).authorizations).toBe(1);
    });

    it("rejects stale review evidence before reserving quantities", async () => {
      const s = await setup();
      s.provider.order.shippingAddress!.zip = "78703";
      await expect(
        s.submission.submitForOrder(
          s.input,
          "synthetic-customer",
          COMPLEX_SCOPE,
        ),
      ).rejects.toMatchObject({ code: "RETURN_LABEL_SUBMISSION_REJECTED" });
      expect(
        (
          await pool.query(
            "SELECT error_code FROM returns.customer_return_submission_commands WHERE idempotency_key=$1",
            [COMPLEX_KEY],
          )
        ).rows[0].error_code,
      ).toBe("RETURN_LIVE_REVIEW_CHANGED");
      expect((await counts()).authorizations).toBe(0);
      expect(s.purchase).not.toHaveBeenCalled();
    });

    it("the canonical database rejects a missing paid-price source value before it can enter the return flow", async () => {
      const s = await setup();
      const before = await sourceFacts();
      await expect(
        pool.query(
          "UPDATE wms.order_items SET paid_price_cents=NULL WHERE id=301",
        ),
      ).rejects.toMatchObject({ code: "23502" });
      expect(await sourceFacts()).toEqual(before);
      expect(await counts()).toEqual({
        authorizations: 0,
        cases: 0,
        parcels: 0,
        attempts: 0,
        inventory: 0,
        refunds: 0,
      });
      expect(s.purchase).not.toHaveBeenCalled();
    });
  },
);
