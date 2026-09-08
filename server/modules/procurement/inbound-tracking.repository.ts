import type pg from "pg";
import { createHash } from "node:crypto";
import { inboundTrackingCommandResultSchema, inboundTrackingConfigSchema, inboundTrackingHistorySchema, inboundTrackingReferenceSchema, inboundTrackingSnapshotSchema, type InboundTrackingConfig, type InboundTrackingHistory, type InboundTrackingReference, type InboundTrackingSnapshot, type SaveInboundTracking } from "@shared/procurement/inbound-tracking";
import { acceptsTrackingSnapshot, InboundTrackingError, TRACKING_LEASE_MS, TRACKING_MINIMUM_REFRESH_MS, TRACKING_SUCCESS_INTERVAL_MS, trackingFingerprint, trackingRetryDelay } from "./inbound-tracking.domain";

interface ReferenceRow {
  id: number; inbound_shipment_id: number; provider: string; reference_type: string; reference: string; carrier_code: string;
  enabled: boolean; include_vessel_position: boolean; revision: number; claim_version: number;
  lease_until: Date | null; next_poll_at: Date | null; refresh_not_before: Date | null;
  last_attempt_at: Date | null; last_success_at: Date | null; failure_count: number;
  last_error_code: string | null; last_error_message: string | null; review_required: boolean;
  current_observation_id: string | null; snapshot?: unknown;
}
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;
function configOf(row: ReferenceRow): InboundTrackingConfig {
  return inboundTrackingConfigSchema.parse({ identity: { provider: row.provider, referenceType: row.reference_type, reference: row.reference, carrierCode: row.carrier_code }, enabled: row.enabled, includeVesselPosition: row.include_vessel_position });
}
function referenceOf(row: ReferenceRow): InboundTrackingReference {
  return inboundTrackingReferenceSchema.parse({ id: row.id, revision: row.revision, config: configOf(row), lastAttemptAt: iso(row.last_attempt_at), lastSuccessAt: iso(row.last_success_at), nextPollAt: iso(row.next_poll_at), failureCount: row.failure_count, lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message, leaseUntil: iso(row.lease_until), reviewRequired: row.review_required, current: row.snapshot == null ? null : inboundTrackingSnapshotSchema.parse(row.snapshot) });
}
export interface InboundTrackingClaim { referenceId: number; shipmentId: number; version: number; startedAt: Date; config: InboundTrackingConfig; }
export interface InboundTrackingFailure { code: string; message: string; retryable: boolean; retryAfterMs: number | null; }
export interface InboundTrackingCommandResult { referenceId: number; revision: number; queued: boolean; }
const requestHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class InboundTrackingRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async read(shipmentId: number): Promise<InboundTrackingReference[]> {
    const shipment = await this.pool.query("SELECT id FROM procurement.inbound_shipments WHERE id = $1", [shipmentId]);
    if (!shipment.rows.length) throw new InboundTrackingError("TRACKING_SHIPMENT_NOT_FOUND", "Shipment not found.", 404);
    const result = await this.pool.query<ReferenceRow>(`SELECT r.*, o.snapshot FROM procurement.inbound_tracking_references r
      LEFT JOIN procurement.inbound_tracking_observations o ON o.id = r.current_observation_id AND o.reference_id = r.id
      WHERE r.inbound_shipment_id = $1 ORDER BY r.id LIMIT 21`, [shipmentId]);
    if (result.rows.length > 20) throw new InboundTrackingError("TRACKING_REFERENCE_LIMIT", "Shipment exceeds the supported 20 tracking references; review configuration.", 409);
    return result.rows.map(referenceOf);
  }
  async history(shipmentId: number, referenceId: number, beforeId: string | null): Promise<InboundTrackingHistory> {
    const exists = await this.pool.query("SELECT id FROM procurement.inbound_tracking_references WHERE id = $1 AND inbound_shipment_id = $2", [referenceId, shipmentId]);
    if (!exists.rows.length) throw new InboundTrackingError("TRACKING_REFERENCE_NOT_FOUND", "Tracking reference not found on this shipment.", 404);
    const [observations, attempts, changes] = await Promise.all([
      this.pool.query<{ id: string; observed_at: Date; snapshot: unknown }>(`SELECT id, observed_at, snapshot FROM procurement.inbound_tracking_observations WHERE reference_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT 26`, [referenceId, beforeId]),
      this.pool.query<{ started_at: Date; completed_at: Date; outcome: string; error_code: string | null; message: string | null }>(`SELECT started_at, completed_at, outcome, error_code, message FROM procurement.inbound_tracking_attempts WHERE reference_id = $1 ORDER BY claim_version DESC LIMIT 25`, [referenceId]),
      this.pool.query<{ revision: number; actor_id: string; recorded_at: Date; before_config: unknown; after_config: unknown }>(`SELECT revision, actor_id, recorded_at, before_config, after_config FROM procurement.inbound_tracking_commands WHERE reference_id = $1 AND operation = 'save' ORDER BY revision DESC LIMIT 25`, [referenceId]),
    ]);
    return inboundTrackingHistorySchema.parse({ observations: observations.rows.slice(0, 25).map((row) => ({ id: row.id, observedAt: row.observed_at.toISOString(), snapshot: row.snapshot })), attempts: attempts.rows.map((row) => ({ startedAt: row.started_at.toISOString(), completedAt: row.completed_at.toISOString(), outcome: row.outcome, errorCode: row.error_code, message: row.message })), changes: changes.rows.map((row) => ({ revision: row.revision, actorId: row.actor_id, recordedAt: row.recorded_at.toISOString(), before: row.before_config, after: row.after_config })), nextObservationCursor: observations.rows.length > 25 ? observations.rows[24].id : null });
  }
  async save(shipmentId: number, command: SaveInboundTracking, actorId: string, now: Date): Promise<InboundTrackingCommandResult> {
    const hash = requestHash({ operation: "save", shipmentId, command, actorId });
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('procurement.inbound-tracking-command'), hashtext($1))", [command.requestKey]);
      const replay = await this.replay(client, command.requestKey, hash);
      if (replay) return replay;
      const shipment = await client.query<{ status: string }>("SELECT status FROM procurement.inbound_shipments WHERE id = $1 FOR UPDATE", [shipmentId]);
      if (!shipment.rows.length) throw new InboundTrackingError("TRACKING_SHIPMENT_NOT_FOUND", "Shipment not found.", 404);
      if (["closed", "cancelled"].includes(shipment.rows[0].status)) throw new InboundTrackingError("TRACKING_SHIPMENT_INACTIVE", "Tracking configuration is read-only for a closed or cancelled shipment.", 409);
      let before: InboundTrackingConfig | null = null;
      let referenceId: number;
      let revision: number;
      const { identity, enabled, includeVesselPosition } = command.config;
      if (command.referenceId === null) {
        if (command.expectedRevision !== 0) throw new InboundTrackingError("TRACKING_REVISION_CONFLICT", "New tracking references require revision zero.", 409);
        const count = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM procurement.inbound_tracking_references WHERE inbound_shipment_id = $1", [shipmentId]);
        if (Number(count.rows[0].count) >= 20) throw new InboundTrackingError("TRACKING_REFERENCE_LIMIT", "A shipment can have at most 20 retained tracking references.", 409);
        const inserted = await client.query<{ id: number }>(`INSERT INTO procurement.inbound_tracking_references
          (inbound_shipment_id, provider, reference_type, reference, carrier_code, enabled, include_vessel_position, revision, next_poll_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,1,$8) ON CONFLICT (inbound_shipment_id, provider, reference_type, reference, carrier_code) DO NOTHING RETURNING id`,
          [shipmentId, identity.provider, identity.referenceType, identity.reference, identity.carrierCode, enabled, includeVesselPosition, enabled ? now : null]);
        if (!inserted.rows.length) throw new InboundTrackingError("TRACKING_REFERENCE_EXISTS", "This tracking reference already exists. Update its current revision.", 409);
        referenceId = inserted.rows[0].id; revision = 1;
      } else {
        const current = await client.query<ReferenceRow>("SELECT * FROM procurement.inbound_tracking_references WHERE id = $1 AND inbound_shipment_id = $2 FOR UPDATE", [command.referenceId, shipmentId]);
        const row = current.rows[0];
        if (!row) throw new InboundTrackingError("TRACKING_REFERENCE_NOT_FOUND", "Tracking reference not found on this shipment.", 404);
        if (row.revision !== command.expectedRevision) throw new InboundTrackingError("TRACKING_REVISION_CONFLICT", "Tracking configuration changed. Refresh and review before saving.", 409);
        before = configOf(row);
        if (JSON.stringify(before.identity) !== JSON.stringify(identity)) throw new InboundTrackingError("TRACKING_IDENTITY_IMMUTABLE", "Pause this reference and add a new one to correct its carrier or number. History stays attached to its original identity.", 409);
        referenceId = row.id; revision = row.revision + 1;
        // Invalidate in-flight work when configuration changes. Existing observations and all attempts remain retained.
        await client.query(`UPDATE procurement.inbound_tracking_references SET enabled=$2, include_vessel_position=$3, revision=$4,
          claim_version=claim_version+1, lease_until=NULL, next_poll_at=CASE WHEN $2 THEN GREATEST($5::timestamptz, refresh_not_before) ELSE NULL END,
          review_required=false, failure_count=0, last_error_code=NULL, last_error_message=NULL WHERE id=$1`, [referenceId, enabled, includeVesselPosition, revision, now]);
      }
      const result = { referenceId, revision, queued: enabled };
      await this.recordCommand(client, { key: command.requestKey, shipmentId, referenceId, hash, actorId, now, operation: "save", revision, before, after: command.config, result });
      return result;
    });
  }
  async requestRefresh(shipmentId: number, referenceId: number, requestKey: string, actorId: string, now: Date): Promise<InboundTrackingCommandResult> {
    const hash = requestHash({ operation: "refresh", shipmentId, referenceId, actorId });
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('procurement.inbound-tracking-command'), hashtext($1))", [requestKey]);
      const replay = await this.replay(client, requestKey, hash);
      if (replay) return replay;
      const found = await client.query<ReferenceRow & { shipment_status: string }>(`SELECT r.*, s.status AS shipment_status FROM procurement.inbound_tracking_references r
        JOIN procurement.inbound_shipments s ON s.id = r.inbound_shipment_id WHERE r.id=$1 AND r.inbound_shipment_id=$2 FOR UPDATE OF r`, [referenceId, shipmentId]);
      const row = found.rows[0];
      if (!row) throw new InboundTrackingError("TRACKING_REFERENCE_NOT_FOUND", "Tracking reference not found on this shipment.", 404);
      if (!row.enabled || ["closed", "cancelled"].includes(row.shipment_status)) throw new InboundTrackingError("TRACKING_REFERENCE_PAUSED", "Enable tracking on an active shipment before requesting a refresh.", 409);
      if ((row.lease_until && row.lease_until > now) || (row.refresh_not_before && row.refresh_not_before > now)) throw new InboundTrackingError("TRACKING_REFRESH_COOLDOWN", "A tracking refresh is pending or was requested recently. Try again after five minutes.", 409);
      await client.query(`UPDATE procurement.inbound_tracking_references SET next_poll_at=$2, refresh_not_before=$3, review_required=false WHERE id=$1`, [referenceId, now, new Date(now.getTime() + TRACKING_MINIMUM_REFRESH_MS)]);
      const result = { referenceId, revision: row.revision, queued: true };
      const config = configOf(row);
      await this.recordCommand(client, { key: requestKey, shipmentId, referenceId, hash, actorId, now, operation: "refresh", revision: row.revision, before: config, after: config, result });
      return result;
    });
  }
  private async replay(client: pg.PoolClient, key: string, hash: string): Promise<InboundTrackingCommandResult | null> {
    const existing = await client.query<{ request_hash: string; response: InboundTrackingCommandResult }>("SELECT request_hash, response FROM procurement.inbound_tracking_commands WHERE request_key = $1", [key]);
    if (!existing.rows.length) return null;
    if (existing.rows[0].request_hash !== hash) throw new InboundTrackingError("TRACKING_IDEMPOTENCY_CONFLICT", "This request key was already used for different tracking changes.", 409);
    return inboundTrackingCommandResultSchema.parse(existing.rows[0].response);
  }
  private async recordCommand(client: pg.PoolClient, input: { key: string; shipmentId: number; referenceId: number; hash: string; actorId: string; now: Date; operation: string; revision: number; before: InboundTrackingConfig | null; after: InboundTrackingConfig; result: InboundTrackingCommandResult }): Promise<void> {
    await client.query(`INSERT INTO procurement.inbound_tracking_commands (request_key,inbound_shipment_id,reference_id,request_hash,actor_id,recorded_at,operation,revision,before_config,after_config,response)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)`, [input.key,input.shipmentId,input.referenceId,input.hash,input.actorId,input.now,input.operation,input.revision,input.before == null ? null : JSON.stringify(input.before),JSON.stringify(input.after),JSON.stringify(input.result)]);
  }
  async claim(now: Date, providers: readonly string[]): Promise<InboundTrackingClaim | null> {
    if (!providers.length) return null;
    return this.transaction(async (client) => {
      const due = await client.query<ReferenceRow>(`SELECT r.* FROM procurement.inbound_tracking_references r
        JOIN procurement.inbound_shipments s ON s.id = r.inbound_shipment_id
        WHERE r.enabled AND NOT r.review_required AND r.provider=ANY($1::text[]) AND s.status NOT IN ('closed','cancelled')
          AND r.next_poll_at <= $2 AND (r.lease_until IS NULL OR r.lease_until <= $2)
        ORDER BY r.next_poll_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`, [providers, now]);
      const row = due.rows[0];
      if (!row) return null;
      const version = row.claim_version + 1;
      const config = configOf(row);
      await client.query(`UPDATE procurement.inbound_tracking_references SET claim_version=$2, lease_until=$3, last_attempt_at=$4, refresh_not_before=$5 WHERE id=$1`, [row.id, version, new Date(now.getTime() + TRACKING_LEASE_MS), now, new Date(now.getTime() + TRACKING_MINIMUM_REFRESH_MS)]);
      return { referenceId: row.id, shipmentId: row.inbound_shipment_id, version, startedAt: now, config };
    });
  }
  async complete(claim: InboundTrackingClaim, now: Date, result: { snapshot: InboundTrackingSnapshot } | { failure: InboundTrackingFailure }): Promise<string> {
    if (now < claim.startedAt) throw new Error("Tracking completion time cannot precede its claim time");
    return this.transaction(async (client) => {
      const current = await client.query<ReferenceRow>(`SELECT r.*,o.snapshot FROM procurement.inbound_tracking_references r LEFT JOIN procurement.inbound_tracking_observations o ON o.reference_id=r.id AND o.id=r.current_observation_id WHERE r.id=$1 FOR UPDATE OF r`, [claim.referenceId]);
      const row = current.rows[0];
      if (!row) throw new Error("Tracking claim has no retained reference");
      const priorAttempt = await client.query<{ outcome: string }>("SELECT outcome FROM procurement.inbound_tracking_attempts WHERE reference_id=$1 AND claim_version=$2", [claim.referenceId, claim.version]);
      if (priorAttempt.rows.length) return priorAttempt.rows[0].outcome;
      let outcome = "superseded_lease";
      let observationId: string | null = null;
      let errorCode: string | null = null;
      let message: string | null = null;
      if ("snapshot" in result) {
        const snapshot = inboundTrackingSnapshotSchema.parse(result.snapshot);
        if (snapshot.reference !== claim.config.identity.reference || snapshot.provider !== claim.config.identity.provider) throw new Error("Tracking snapshot identity differs from its claim");
        const hash = trackingFingerprint(snapshot);
        const observation = await client.query<{ id: string }>(`INSERT INTO procurement.inbound_tracking_observations(reference_id,fingerprint,observed_at,snapshot) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(reference_id,fingerprint) DO NOTHING RETURNING id`, [row.id,hash,now,JSON.stringify(snapshot)]);
        observationId = observation.rows[0]?.id ?? (await client.query<{ id: string }>("SELECT id FROM procurement.inbound_tracking_observations WHERE reference_id=$1 AND fingerprint=$2", [row.id,hash])).rows[0].id;
        if (row.claim_version === claim.version && row.lease_until !== null && row.lease_until >= now && row.enabled) {
          const oldSnapshot = row.snapshot == null ? null : inboundTrackingSnapshotSchema.parse(row.snapshot);
          const accepted = acceptsTrackingSnapshot(oldSnapshot, snapshot);
          outcome = accepted ? (row.current_observation_id === observationId ? "duplicate" : "applied") : "stale_source";
          errorCode = accepted ? null : "TRACKING_STALE_SOURCE";
          message = accepted ? null : "Provider returned older or incomplete evidence. The previous observation remains current.";
          await client.query(`UPDATE procurement.inbound_tracking_references SET current_observation_id=$2, last_success_at=$3, lease_until=NULL,
            next_poll_at=$4, failure_count=0, last_error_code=$5, last_error_message=$6, review_required=false WHERE id=$1`, [row.id, accepted ? observationId : row.current_observation_id, now, new Date(now.getTime() + TRACKING_SUCCESS_INTERVAL_MS), errorCode, message]);
        }
      } else if (row.claim_version === claim.version && row.lease_until !== null && row.lease_until >= now && row.enabled) {
        const failureCount = row.failure_count + 1;
        outcome = result.failure.retryable ? "retry" : "review";
        errorCode = result.failure.code; message = result.failure.message;
        await client.query(`UPDATE procurement.inbound_tracking_references SET lease_until=NULL, next_poll_at=$2, failure_count=$3,
          last_error_code=$4,last_error_message=$5,review_required=$6 WHERE id=$1`, [row.id, result.failure.retryable ? new Date(now.getTime() + trackingRetryDelay(failureCount, result.failure.retryAfterMs)) : null, failureCount, errorCode, message, !result.failure.retryable]);
      }
      await client.query(`INSERT INTO procurement.inbound_tracking_attempts(reference_id,claim_version,started_at,completed_at,outcome,observation_id,error_code,message)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(reference_id,claim_version) DO NOTHING`, [row.id,claim.version,claim.startedAt,now,outcome,observationId,errorCode,message]);
      return outcome;
    });
  }
}
