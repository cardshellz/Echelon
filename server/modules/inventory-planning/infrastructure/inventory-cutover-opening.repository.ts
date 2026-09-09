import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { openingAssessmentSchema, openingSavedSchema, openingSaveRequestSchema, openingSourceSchema,
  openingVerificationSchema, type OpeningAssessment, type OpeningSaved, type OpeningSource,
  type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import type { CutoverReconstructionEvidence } from "@shared/types/inventory-cutover-reconstruction";
import { InventoryCutoverOpeningError, type InventoryCutoverOpeningStore,
  type OpeningSaveCommand } from "../application/inventory-cutover-opening.service";
import { evaluateCutoverOpening } from "../domain/inventory-cutover-opening";
import { reconstructionEvidenceHash, reconstructionHash } from "../domain/inventory-cutover-reconstruction";
import { PostgresInventoryCutoverReconstructionRepository } from "./inventory-cutover-reconstruction.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { inInventoryCutoverTransaction, lockInventoryCutoverCommandInsideTransaction } from "./inventory-cutover-commit.repository";
import { loadCutoverOpeningReplay, loadLatestCutoverOpening } from "./inventory-cutover-opening.reader";

const positiveBigint = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => BigInt(value) <= BigInt("9223372036854775807"));
const authoritySchema = z.object({ runtimeAuthority: z.enum(["legacy", "canonical"]), authorityRevision: positiveBigint,
  configurationRunId: positiveBigint.nullable(), freezeCount: z.number().int().min(0).max(1) }).strict();

/** The only write is a separate immutable opening audit. Physical counters,
 * historical journals, costs, claims and authority remain untouched. */
export class PostgresInventoryCutoverOpeningRepository implements InventoryCutoverOpeningStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool,
    private readonly evidenceReader: { capture(client: PoolClient): Promise<CutoverReconstructionEvidence> }
      = new PostgresInventoryCutoverReconstructionRepository()) {}

  async capture(occurredAt: Date): Promise<OpeningSource> {
    return inInventoryCutoverTransaction(this.connectionPool, "read_only_review", async client => {
      const authority = await readAuthority(client);
      const evidence = await this.evidenceReader.capture(client);
      const labels = await readOpeningLabels(client, evidence);
      const latest = await loadLatestCutoverOpening(client);
      return openingSourceSchema.parse({ contractVersion: "inventory_cutover_opening_source_v1",
        capturedAt: occurredAt.toISOString(), runtimeAuthority: authority.runtimeAuthority,
        authorityRevision: authority.authorityRevision, configurationRunId: authority.configurationRunId,
        evidenceHash: reconstructionEvidenceHash(evidence), evidence, labels, latestVerification: latest?.saved ?? null });
    });
  }

  async preview(rawVerification: OpeningVerification, occurredAt: Date): Promise<OpeningAssessment> {
    const verification = openingVerificationSchema.parse(rawVerification);
    assertTime(verification, occurredAt);
    return inInventoryCutoverTransaction(this.connectionPool, "read_only_review", async client => {
      assertAuthority(await readAuthority(client), verification);
      return openingAssessmentSchema.parse(evaluateCutoverOpening(await this.evidenceReader.capture(client), verification));
    });
  }

  async save(command: OpeningSaveCommand): Promise<OpeningSaved> {
    const { actor, occurredAt, requestHash, ...rawRequest } = command;
    const request = openingSaveRequestSchema.parse(rawRequest);
    if (!z.string().trim().min(1).max(100).safeParse(actor).success
      || actor !== actor.trim() || requestHash !== reconstructionHash({ contractVersion: "inventory_cutover_opening_save_v1", actor, ...request })) {
      throw new InventoryCutoverOpeningError("CUTOVER_OPENING_COMMAND_INVALID", "The authenticated opening command is invalid.", 400);
    }
    assertTime(request.verification, occurredAt);
    return inInventoryCutoverTransaction(this.connectionPool, "admitted_commit", async client => {
      await lockInventoryCutoverCommandInsideTransaction(client, `opening:${request.idempotencyKey}`);
      const replay = await loadCutoverOpeningReplay(client, request.idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new InventoryCutoverOpeningError(
          "CUTOVER_OPENING_IDEMPOTENCY_CONFLICT", "The command key belongs to different opening facts or an actor.");
        return openingSavedSchema.parse({ ...replay.saved, alreadyApplied: true });
      }
      const fence = await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "legacy", expectedConfigurationRunId: request.verification.expectedConfigurationRunId,
      });
      assertAuthority({ runtimeAuthority: fence.authority, authorityRevision: fence.authorityRevision,
        configurationRunId: fence.configurationRunId }, request.verification);
      const evidence = await this.evidenceReader.capture(client);
      const assessment = openingAssessmentSchema.parse(evaluateCutoverOpening(evidence, request.verification));
      if (!assessment.ready || !assessment.plan.ready) throw new InventoryCutoverOpeningError(
        "CUTOVER_OPENING_BLOCKED", "The current evidence does not support this complete opening verification.",
        409, { blockers: assessment.blockers });
      if (assessment.sourceEvidenceHash !== request.verification.expectedEvidenceHash) throw new InventoryCutoverOpeningError(
        "CUTOVER_OPENING_EVIDENCE_CHANGED", "Current inventory or demand changed after verification.");
      const existing = (await client.query(`SELECT id::text FROM inventory.availability_cutover_opening_snapshots
        WHERE authority_revision=$1 AND source_evidence_hash=$2`,
      [fence.authorityRevision, assessment.sourceEvidenceHash])).rows;
      if (existing.length > 0) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_ALREADY_VERIFIED",
        "This exact current snapshot already has an immutable verification. Replay its original command key.");
      // Reserve an audit identity before building its hashed immutable receipt.
      // Gaps after rollback are expected sequence behavior, not missing evidence.
      const id = (await client.query<{ id: string }>(`SELECT nextval(pg_get_serial_sequence(
        'inventory.availability_cutover_opening_snapshots','id'))::text AS id`)).rows[0]?.id;
      const saved = openingSavedSchema.parse({ id, sourceEvidenceHash: assessment.sourceEvidenceHash,
        verificationHash: assessment.verificationHash, authorityRevision: fence.authorityRevision,
        historicalExceptionHash: assessment.historicalExceptionHash,
        historicalExceptionCount: assessment.historicalExceptions.length,
        verifiedAt: request.verification.verifiedAt, actor, reason: request.reason, alreadyApplied: false,
        stockChanged: false, authorityChanged: false });
      const inserted = await client.query(`INSERT INTO inventory.availability_cutover_opening_snapshots
        (id,authority_revision,configuration_run_id,source_evidence_hash,verification_hash,historical_exception_hash,
         request_hash,result_hash,evidence_payload,verification_payload,assessment_payload,request_payload,result_payload,
         idempotency_key,actor,reason,verified_at,occurred_at)
        OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18)`,
      [id, fence.authorityRevision, fence.configurationRunId, assessment.sourceEvidenceHash, assessment.verificationHash,
        assessment.historicalExceptionHash, requestHash, reconstructionHash(saved), JSON.stringify(evidence),
        JSON.stringify(request.verification), JSON.stringify(assessment), JSON.stringify(request), JSON.stringify(saved),
        request.idempotencyKey, actor, request.reason, request.verification.verifiedAt, occurredAt.toISOString()]);
      if (inserted.rowCount !== 1) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_INSERT_INCOMPLETE",
        "The immutable opening verification was not inserted exactly once.", 500);
      return saved;
    });
  }
}

async function readAuthority(client: PoolClient) {
  const rows = (await client.query(`SELECT authority.authority AS "runtimeAuthority", authority.revision::text AS "authorityRevision",
    (SELECT max(activation_run_id)::text FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS "configurationRunId",
    (SELECT count(*)::integer FROM inventory.availability_activation_freezes WHERE released_at IS NULL) AS "freezeCount"
    FROM inventory.availability_runtime_authority authority WHERE singleton_key=true`)).rows;
  const authority = rows.length === 1 ? authoritySchema.safeParse(rows[0]) : null;
  if (!authority?.success) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_AUTHORITY_INVALID",
    "Current authority and configuration freeze evidence is incomplete.", 500);
  return authority.data;
}

function assertAuthority(authority: { runtimeAuthority: string; authorityRevision: string; configurationRunId: string | null },
  verification: OpeningVerification): void {
  if (authority.runtimeAuthority !== "legacy" || authority.authorityRevision !== verification.expectedAuthorityRevision
    || authority.configurationRunId !== verification.expectedConfigurationRunId) throw new InventoryCutoverOpeningError(
    "CUTOVER_OPENING_AUTHORITY_CHANGED", "Runtime authority or configuration freeze changed after the opening capture.");
}

function assertTime(verification: OpeningVerification, occurredAt: Date): void {
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) throw new InventoryCutoverOpeningError(
    "CUTOVER_OPENING_CLOCK_INVALID", "The opening verification clock is invalid.", 500);
  if (Date.parse(verification.verifiedAt) > occurredAt.getTime()) throw new InventoryCutoverOpeningError(
    "CUTOVER_OPENING_VERIFICATION_TIME_INVALID", "The verification cannot be dated in the future.", 400);
}

async function readOpeningLabels(client: PoolClient, evidence: CutoverReconstructionEvidence): Promise<OpeningSource["labels"]> {
  const distinct = (values: Array<number | null>) => [...new Set(values.filter((value): value is number => value !== null))].sort((a,b) => a-b);
  const orderIds = distinct(evidence.orders.map(row => row.id));
  const variantIds = distinct([...evidence.variants.map(row => row.id), ...evidence.levels.map(row => row.productVariantId),
    ...evidence.lots.map(row => row.productVariantId)]);
  const warehouseIds = distinct([...evidence.orders.map(row => row.warehouseId), ...evidence.levels.map(row => row.warehouseId)]);
  const locationIds = distinct([...evidence.levels.map(row => row.warehouseLocationId), ...evidence.lots.map(row => row.warehouseLocationId)]);
  // Labels are display-only lookups by already-proven IDs; never used to infer
  // stock ownership through SKU, order-number text, bin text or tracking.
  return (await client.query(`SELECT 'order' AS kind, id::text,
      COALESCE(NULLIF(order_number::text,''),NULLIF(external_order_id,''),'Order '||id::text) AS label
      FROM wms.orders WHERE id=ANY($1::integer[])
    UNION ALL SELECT 'variant', id::text, COALESCE(NULLIF(sku,''),'Variant '||id::text)
      FROM catalog.product_variants WHERE id=ANY($2::integer[])
    UNION ALL SELECT 'warehouse', id::text, COALESCE(NULLIF(concat_ws(' - ',NULLIF(code,''),NULLIF(name,'')),''),'Warehouse '||id::text)
      FROM warehouse.warehouses WHERE id=ANY($3::integer[])
    UNION ALL SELECT 'location', id::text, COALESCE(NULLIF(concat_ws(' - ',NULLIF(code,''),NULLIF(name,'')),''),'Location '||id::text)
      FROM warehouse.warehouse_locations WHERE id=ANY($4::integer[])
    ORDER BY kind,id`, [orderIds, variantIds, warehouseIds, locationIds])).rows as OpeningSource["labels"];
}
