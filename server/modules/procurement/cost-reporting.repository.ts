import { costSourceRevisionSchema } from "@shared/procurement/cost-source-contracts";
import type { Pool, PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import { costReportEnvelopeSchema, retryCostReportSchema, type CostReportAcknowledgement, type CostReportEnvelope } from "@shared/procurement/cost-report-delivery";
import { buildCostReportEnvelope, COST_REPORT_BATCH_SIZE, COST_REPORT_LEASE_MS, COST_REPORT_MAX_ATTEMPTS, CostReportingError, nextReportFailure, reportHash, verifyReportAcknowledgement, type ReportDestination } from "./cost-reporting.domain";

export type ReportingDatabase = Pick<Pool, "connect">;
export type ClaimedCostReport = { id: string; leaseToken: string; attemptCount: number; cycleAttemptCount: number; envelope: CostReportEnvelope };
type Row = Record<string, any>;
const columns = `id,source_event_id::text AS "sourceEventId",application_id::text AS "applicationId",destination_id AS "destinationId",state,
  attempt_count AS "attemptCount",next_attempt_at AS "nextAttemptAt",last_error_code AS "lastErrorCode",last_error_message AS "lastErrorMessage",
  acknowledgement,recorded_at AS "recordedAt",updated_at AS "updatedAt"`;
const instant = (value: Date | string): string => new Date(value).toISOString();
export class CostReportingRepository {
  constructor(private readonly database: ReportingDatabase) {}
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.database.connect(); let destroy = false;
    try { await tx.query("BEGIN"); await tx.query("SET LOCAL statement_timeout='10s'"); const result = await work(tx); await tx.query("COMMIT"); return result; }
    catch (error) { try { await tx.query("ROLLBACK"); } catch (rollbackError) { destroy = true; throw new AggregateError([error,rollbackError],"Reporting transaction and rollback failed"); } throw error; }
    finally { tx.release(destroy); }
  }
  private async audit(tx: PoolClient, deliveryId: string, action: string, actor: string, before: unknown, after: unknown, now: Date): Promise<void> {
    await tx.query(`INSERT INTO procurement.cost_report_delivery_audit(delivery_id,action,actor,before_state,after_state,recorded_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [deliveryId,action,actor,before == null ? null : canonicalJson(before),canonicalJson(after),now]);
  }
  private async bind(tx: PoolClient, destination: ReportDestination, now: Date): Promise<void> {
    const bindingHash = reportHash({ id: destination.id, sourceSystemId: destination.sourceSystemId, endpoint: destination.endpoint });
    await tx.query(`INSERT INTO procurement.cost_reporting_destinations(id,source_system_id,endpoint,binding_hash,recorded_by,recorded_at)
      VALUES($1,$2,$3,$4,'system:cost-reporting',$5) ON CONFLICT(id) DO NOTHING`,[destination.id,destination.sourceSystemId,destination.endpoint,bindingHash,now]);
    const binding = await tx.query(`SELECT binding_hash FROM procurement.cost_reporting_destinations WHERE id=$1`,[destination.id]);
    if (binding.rows[0]?.binding_hash !== bindingHash) throw new CostReportingError("COST_REPORT_DESTINATION_CHANGED", "This reporting destination is bound to another source or URL. Use a separately reviewed destination identity.");
  }
  async enqueue(destination: ReportDestination, now: Date, newId: () => string): Promise<number> {
    if (!destination.enabled) return 0;
    return this.transaction(async (tx) => {
      await this.bind(tx,destination,now);
      const candidates = await tx.query(`SELECT event.id::text AS "eventId",event.application_id::text AS "applicationId",event.payload,event.contract_version,event.recorded_at,
        a.recorded_by AS "applicationActor",a.recorded_at AS "applicationRecordedAt",a.status,a.evidence->'result' AS outcome,r.id::text AS "sourceRevisionId",r.contract AS "sourceContract",r.inbound_shipment_line_id AS "shipmentLineId",r.fingerprint,r.component,r.contract->>'currency' AS currency,
        r.purchase_order_line_id AS "purchaseOrderLineId",pol.purchase_order_id AS "purchaseOrderId",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('lotId',c.inventory_lot_id,'before',c.before_state,'after',c.after_state) ORDER BY c.inventory_lot_id)
          FROM inventory.cost_application_lots c WHERE c.application_id=a.id),'[]'::jsonb) AS changes
        FROM inventory.cost_reporting_events event JOIN inventory.cost_applications a ON a.id=event.application_id
        JOIN procurement.cost_source_revisions r ON r.id=a.source_revision_id JOIN procurement.purchase_order_lines pol ON pol.id=r.purchase_order_line_id
        WHERE NOT EXISTS(SELECT 1 FROM procurement.cost_report_deliveries d WHERE d.source_event_id=event.id AND d.destination_id=$1)
        ORDER BY event.id LIMIT 10`,[destination.id]);
      let inserted = 0;
      for (const row of candidates.rows as Row[]) {
        const id = newId(); let envelope: CostReportEnvelope | null = null; let failure: CostReportingError | null = null;
        try {
          envelope = buildCostReportEnvelope({ destination,deliveryId:id,sourceEventId:row.eventId,applicationId:row.applicationId,
            purchaseOrderId:row.purchaseOrderId,purchaseOrderLineId:row.purchaseOrderLineId,payload:row.payload });
          const payload = envelope.payload;
          const source = costSourceRevisionSchema.safeParse(row.sourceContract);
          if (!source.success || source.data.fingerprint !== row.fingerprint || source.data.component !== row.component
            || source.data.scope.purchaseOrderId !== row.purchaseOrderId || source.data.scope.purchaseOrderLineId !== row.purchaseOrderLineId
            || (source.data.scope.kind === "shipment_line" ? source.data.scope.inboundShipmentLineId : null) !== row.shipmentLineId
            || row.applicationActor !== payload.actorId || instant(row.applicationRecordedAt) !== instant(payload.recordedAt)
            || row.contract_version !== 1 || row.status !== "applied" || row.outcome?.status !== "applied"
            || row.outcome.lotsUpdated !== payload.changes.length || row.outcome.totalCogsDeltaCents !== payload.cogsDeltaCents
            || String(payload.sourceRevisionId) !== row.sourceRevisionId || payload.sourceFingerprint !== row.fingerprint
            || payload.component !== row.component || payload.currency !== row.currency || instant(row.recorded_at) !== instant(payload.recordedAt)
            || reportHash([...payload.changes].sort((a,b) => a.lotId-b.lotId)) !== reportHash(row.changes)) {
            throw new CostReportingError("COST_REPORT_SOURCE_CONFLICT", "The retained reporting event does not reconcile to its immutable application and lot snapshots.");
          }
        } catch (error) { envelope = null; failure = error instanceof CostReportingError ? error : new CostReportingError("COST_REPORT_SOURCE_INVALID", "The retained reporting event has invalid or unsupported source evidence."); }
        const state = failure ? "dead_letter" : "queued";
        const saved = await tx.query(`INSERT INTO procurement.cost_report_deliveries(id,destination_id,source_event_id,application_id,purchase_order_id,envelope,state,next_attempt_at,last_error_code,last_error_message,recorded_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$11) ON CONFLICT(destination_id,source_event_id) DO NOTHING RETURNING id`,
        [id,destination.id,row.eventId,row.applicationId,row.purchaseOrderId,envelope ? canonicalJson(envelope) : null,state,failure ? null : now,failure?.code ?? null,failure?.message ?? null,now]);
        if (saved.rowCount) { inserted++; await this.audit(tx,id,"enqueued","system:cost-reporting",null,{state,sourceEventId:row.eventId,reportHash:envelope?.reportHash ?? null,errorCode:failure?.code ?? null},now); }
      }
      return inserted;
    });
  }
  async claim(destination: ReportDestination, now: Date, newToken: () => string): Promise<ClaimedCostReport[]> {
    if (!destination.enabled) return [];
    return this.transaction(async (tx) => {
      await this.bind(tx,destination,now);
      const rows = await tx.query(`SELECT * FROM procurement.cost_report_deliveries WHERE destination_id=$1 AND
        ((state IN ('queued','retry_required') AND next_attempt_at <= $2) OR (state='processing' AND lease_expires_at <= $2))
        ORDER BY source_event_id LIMIT $3 FOR UPDATE SKIP LOCKED`,[destination.id,now,COST_REPORT_BATCH_SIZE]);
      const claimed: ClaimedCostReport[] = [];
      for (const row of rows.rows as Row[]) {
        if (row.cycle_attempt_count >= COST_REPORT_MAX_ATTEMPTS) {
          await tx.query(`UPDATE procurement.cost_report_deliveries SET state='dead_letter',lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
            last_error_code='COST_REPORT_ATTEMPTS_EXHAUSTED',last_error_message='Automatic delivery attempts exhausted; review and retry explicitly.',updated_at=$2 WHERE id=$1`,[row.id,now]);
          await this.audit(tx,row.id,"exhausted","system:cost-reporting",{state:row.state,attemptCount:row.attempt_count},{state:"dead_letter"},now); continue;
        }
        const envelope = costReportEnvelopeSchema.parse(row.envelope), token = newToken();
        if (envelope.destinationId !== destination.id || envelope.sourceSystemId !== destination.sourceSystemId || envelope.deliveryId !== row.id) throw new CostReportingError("COST_REPORT_BINDING_CONFLICT", "A retained report conflicts with its destination binding.");
        await tx.query(`UPDATE procurement.cost_report_deliveries SET state='processing',attempt_count=attempt_count+1,cycle_attempt_count=cycle_attempt_count+1,
          lease_token=$2,lease_expires_at=$3,next_attempt_at=NULL,updated_at=$4 WHERE id=$1`,[row.id,token,new Date(now.getTime()+COST_REPORT_LEASE_MS),now]);
        await this.audit(tx,row.id,row.state === "processing" ? "lease_reclaimed" : "claimed","system:cost-reporting",{state:row.state,attemptCount:row.attempt_count},{state:"processing",attemptCount:row.attempt_count+1,leaseToken:token},now);
        claimed.push({id:row.id,leaseToken:token,attemptCount:row.attempt_count+1,cycleAttemptCount:row.cycle_attempt_count+1,envelope});
      }
      return claimed;
    });
  }
  async finish(claim: ClaimedCostReport, outcome: { acknowledgement: CostReportAcknowledgement } | { error: CostReportingError }, now: Date): Promise<boolean> {
    return this.transaction(async (tx) => {
      const selected = await tx.query(`SELECT * FROM procurement.cost_report_deliveries WHERE id=$1 FOR UPDATE`,[claim.id]);
      const row = selected.rows[0];
      if (!row || row.state !== "processing" || row.lease_token !== claim.leaseToken || row.attempt_count !== claim.attemptCount || new Date(row.lease_expires_at).getTime() <= now.getTime()) return false;
      const ack = "acknowledgement" in outcome ? verifyReportAcknowledgement(outcome.acknowledgement,costReportEnvelopeSchema.parse(row.envelope)) : null;
      const failure = "error" in outcome ? nextReportFailure(claim.cycleAttemptCount,outcome.error,now) : null;
      const state = ack ? "acknowledged" : failure!.state;
      const error = "error" in outcome ? outcome.error : null;
      await tx.query(`UPDATE procurement.cost_report_deliveries SET state=$2,acknowledgement=$3::jsonb,next_attempt_at=$4,lease_token=NULL,lease_expires_at=NULL,
        last_error_code=$5,last_error_message=$6,updated_at=$7 WHERE id=$1`,[claim.id,state,ack ? canonicalJson(ack) : null,failure?.nextAttemptAt ?? null,error?.code ?? null,error?.message ?? null,now]);
      await this.audit(tx,claim.id,ack ? "acknowledged" : "delivery_failed","system:cost-reporting",{state:"processing",attemptCount:row.attempt_count},
        {state,attemptCount:row.attempt_count,acknowledgement:ack,errorCode:error?.code ?? null},now);
      return true;
    });
  }
  async list(purchaseOrderId: number, destinationId: string | null): Promise<{ deliveries: Row[]; unqueuedEventCount: number; truncated: boolean }> {
    return this.transaction(async (tx) => {
      const purchase = await tx.query(`SELECT id FROM procurement.purchase_orders WHERE id=$1`,[purchaseOrderId]);
      if (!purchase.rowCount) throw new CostReportingError("PURCHASE_ORDER_NOT_FOUND", "The purchase order was not found.",false,404);
      const rows = await tx.query(`SELECT ${columns} FROM procurement.cost_report_deliveries WHERE purchase_order_id=$1 ORDER BY recorded_at DESC,id LIMIT 501`,[purchaseOrderId]);
      const counts = await tx.query(`SELECT COUNT(*)::text AS count FROM inventory.cost_reporting_events e
        JOIN inventory.cost_applications a ON a.id=e.application_id JOIN procurement.cost_source_revisions r ON r.id=a.source_revision_id
        JOIN procurement.purchase_order_lines p ON p.id=r.purchase_order_line_id WHERE p.purchase_order_id=$1
        AND NOT EXISTS(SELECT 1 FROM procurement.cost_report_deliveries d WHERE d.source_event_id=e.id AND ($2::uuid IS NULL OR d.destination_id=$2))`,[purchaseOrderId,destinationId]);
      const count = Number(counts.rows[0].count);
      if (!Number.isSafeInteger(count)) throw new CostReportingError("COST_REPORT_COUNT_INVALID","Reporting count exceeds the supported range.");
      return { deliveries:rows.rows.slice(0,500).map((row) => ({...row,recordedAt:instant(row.recordedAt),updatedAt:instant(row.updatedAt),nextAttemptAt:row.nextAttemptAt ? instant(row.nextAttemptAt) : null})),unqueuedEventCount:count,truncated:rows.rows.length>500 };
    });
  }
  async retry(input: { purchaseOrderId: number; deliveryId: string; key: string; actor: string; command: unknown }, destination: ReportDestination | null, now: Date): Promise<{ deliveryId: string; state: "queued"; replayed: boolean }> {
    const command = retryCostReportSchema.parse(input.command), requestHash = reportHash(command);
    if (!input.actor.trim() || input.key.length < 8 || input.key.length > 200) throw new CostReportingError("COST_REPORT_RETRY_INVALID","An authenticated actor and idempotency key are required.",false,400);
    return this.transaction(async (tx) => {
      const rows = await tx.query(`SELECT * FROM procurement.cost_report_deliveries WHERE id=$1 AND purchase_order_id=$2 FOR UPDATE`,[input.deliveryId,input.purchaseOrderId]);
      const row = rows.rows[0]; if (!row) throw new CostReportingError("COST_REPORT_NOT_FOUND","This purchase report was not found.",false,404);
      const prior = await tx.query(`SELECT request_hash,result FROM procurement.cost_report_retry_intents WHERE delivery_id=$1 AND actor=$2 AND idempotency_key=$3`,[input.deliveryId,input.actor,input.key]);
      if (prior.rows[0]) { if (prior.rows[0].request_hash !== requestHash) throw new CostReportingError("COST_REPORT_RETRY_CONFLICT","That retry key belongs to a different request."); return {...prior.rows[0].result,replayed:true}; }
      if (!destination?.enabled || destination.id !== row.destination_id) throw new CostReportingError("COST_REPORT_DESTINATION_UNAVAILABLE","Enable this report's bound destination before retrying.");
      await this.bind(tx,destination,now);
      if (row.attempt_count !== command.expectedAttemptCount) throw new CostReportingError("COST_REPORT_RETRY_STALE","Delivery changed; refresh its status before retrying.");
      if (!row.envelope || !["retry_required","dead_letter","processing"].includes(row.state)
        || (row.state === "processing" && new Date(row.lease_expires_at).getTime() > now.getTime())) throw new CostReportingError("COST_REPORT_RETRY_NOT_ALLOWED","This delivery cannot be retried in its current state. Invalid source events require source review.");
      await tx.query(`UPDATE procurement.cost_report_deliveries SET state='queued',cycle_attempt_count=0,next_attempt_at=$2,lease_token=NULL,lease_expires_at=NULL,last_error_code=NULL,last_error_message=NULL,updated_at=$2 WHERE id=$1`,[row.id,now]);
      const result = {deliveryId:row.id,state:"queued" as const};
      await this.audit(tx,row.id,"retry_requested",input.actor,{state:row.state,attemptCount:row.attempt_count},{...result,reason:command.reason},now);
      await tx.query(`INSERT INTO procurement.cost_report_retry_intents(delivery_id,actor,idempotency_key,request_hash,result,recorded_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[row.id,input.actor,input.key,requestHash,canonicalJson(result),now]);
      return {...result,replayed:false};
    });
  }
}
