import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { DEFAULT_SUPPLIER_SOURCING_POLICY, SOURCING_MAX_CANDIDATES, sourcingId, supplierSourcingRecordSchema, type SupplierSourcingRecord, type SupplierSourcingPolicy } from "@shared/procurement/supplier-sourcing";
import type { PurchasingRecommendationRawRow } from "./purchasing-recommendation.engine";
import { supplierCandidateSchema, type SupplierCandidate } from "./supplier-sourcing-selection";

export interface SupplierSourcingExecutor { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> }
export interface SupplierSourcingDatabase extends SupplierSourcingExecutor { transaction<T>(callback: (tx: SupplierSourcingExecutor) => Promise<T>): Promise<T> }
const dbInteger = z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number).pipe(z.number().int().nonnegative().safe());
function timestamp(value: unknown): string { const parsed = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(parsed.getTime())) throw new Error("Supplier policy timestamp is invalid"); return parsed.toISOString(); }
export function supplierSourcingRecord(row: Record<string, unknown>): SupplierSourcingRecord {
  return supplierSourcingRecordSchema.parse({ vendorProductId: dbInteger.parse(row.vendor_product_id), revision: dbInteger.parse(row.revision), policy: row.policy,
    recordedBy: row.recorded_by, recordedAt: timestamp(row.recorded_at), reason: row.reason });
}
export function emptySupplierSourcingRecord(vendorProductId: number): SupplierSourcingRecord {
  return { vendorProductId: sourcingId.parse(vendorProductId), revision: 0, policy: supplierSourcingRecordSchema.shape.policy.parse(DEFAULT_SUPPLIER_SOURCING_POLICY), recordedBy: null, recordedAt: null, reason: null };
}
export async function loadSupplierSourcingRecords(tx: SupplierSourcingExecutor, ids: readonly number[]): Promise<Map<number, SupplierSourcingRecord>> {
  if (!ids.length) return new Map();
  const keys = [...new Set(ids.map((id) => sourcingId.parse(id)))].sort((a,b) => a-b);
  const rows = await tx.execute(sql`SELECT DISTINCT ON (vendor_product_id) * FROM procurement.supplier_sourcing_revisions WHERE vendor_product_id IN (${sql.join(keys.map((id) => sql`${id}`), sql`, `)}) ORDER BY vendor_product_id, revision DESC`);
  return new Map(rows.rows.map((row) => { const record = supplierSourcingRecord(row); return [record.vendorProductId, record]; }));
}

export class SupplierSourcingRepository {
  constructor(readonly database: SupplierSourcingDatabase) {}
  transaction<T>(callback: (tx: SupplierSourcingExecutor) => Promise<T>): Promise<T> { return this.database.transaction(callback); }
  async read(vendorProductId: number): Promise<SupplierSourcingRecord | null> {
    const mapping = await this.database.execute(sql`SELECT id FROM procurement.vendor_products WHERE id = ${vendorProductId}`);
    if (!mapping.rows.length) return null;
    return (await loadSupplierSourcingRecords(this.database, [vendorProductId])).get(vendorProductId) ?? emptySupplierSourcingRecord(vendorProductId);
  }
  async history(vendorProductId: number, beforeRevision: number | null) {
    const rows = await this.database.execute(sql`SELECT * FROM procurement.supplier_sourcing_revisions WHERE vendor_product_id = ${vendorProductId} ${beforeRevision === null ? sql`` : sql`AND revision < ${beforeRevision}`} ORDER BY revision DESC LIMIT 51`);
    const records = rows.rows.slice(0,50).map(supplierSourcingRecord);
    return { records, nextBeforeRevision: rows.rows.length > 50 ? records[records.length - 1].revision : null };
  }
  async lockMapping(tx: SupplierSourcingExecutor, vendorProductId: number): Promise<boolean> {
    // Same graph-first protocol as catalog/PO writers. Later supplier edits and
    // PO acceptance cannot race a newly activated price list.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'), hashtext('version_1'))`);
    return (await tx.execute(sql`SELECT id FROM procurement.vendor_products WHERE id = ${vendorProductId} FOR UPDATE`)).rows.length === 1;
  }
  async replay(tx: SupplierSourcingExecutor, vendorProductId: number, key: string) {
    const rows = await tx.execute(sql`SELECT * FROM procurement.supplier_sourcing_revisions WHERE vendor_product_id = ${vendorProductId} AND idempotency_key = ${key}::uuid`);
    return rows.rows.length ? { requestHash: z.string().parse(rows.rows[0].request_hash), result: supplierSourcingRecord(rows.rows[0]) } : null;
  }
  async insert(tx: SupplierSourcingExecutor, input: { current: SupplierSourcingRecord; policy: SupplierSourcingPolicy; idempotencyKey: string; requestHash: string; reason: string; actorId: string; at: Date }): Promise<SupplierSourcingRecord> {
    const rows = await tx.execute(sql`INSERT INTO procurement.supplier_sourcing_revisions (vendor_product_id, revision, idempotency_key, request_hash, before_policy, policy, reason, recorded_by, recorded_at)
      VALUES (${input.current.vendorProductId}, ${input.current.revision + 1}, ${input.idempotencyKey}::uuid, ${input.requestHash}, ${JSON.stringify(input.current.policy)}::jsonb, ${JSON.stringify(input.policy)}::jsonb, ${input.reason}, ${input.actorId}, ${input.at}) RETURNING *`);
    return supplierSourcingRecord(rows.rows[0]);
  }
}

/** Read all compatible identities in the same repeatable-read planning
 * snapshot as inventory/receipts. No per-product or per-supplier query loops. */
export async function attachSupplierSourcingCandidates(tx: SupplierSourcingExecutor, rows: PurchasingRecommendationRawRow[]): Promise<PurchasingRecommendationRawRow[]> {
  if (!rows.length) return [];
  const productIds = [...new Set(rows.map((row) => sourcingId.parse(Number(row.product_id))))];
  const result = await tx.execute(sql`SELECT to_jsonb(vp) AS mapping, v.id AS vendor_id, v.name AS vendor_name, v.active AS vendor_active,
      v.currency, v.default_lead_time_days, v.minimum_order_cents, v.free_freight_threshold_cents,
      revision.revision, revision.policy
    FROM procurement.vendor_products vp JOIN procurement.vendors v ON v.id = vp.vendor_id
    LEFT JOIN LATERAL (SELECT revision, policy FROM procurement.supplier_sourcing_revisions WHERE vendor_product_id = vp.id ORDER BY revision DESC LIMIT 1) revision ON true
    WHERE vp.product_id IN (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY vp.product_id, vp.id LIMIT 10001`);
  if (result.rows.length > 10000) throw new Error("Supplier sourcing snapshot exceeds 10000 mappings; narrow the planning scope before retrying");
  const byProduct = new Map<number, SupplierCandidate[]>();
  for (const row of result.rows) {
    const candidate = supplierCandidateSchema.parse({ mapping: row.mapping, vendorId: row.vendor_id, vendorName: row.vendor_name, vendorActive: row.vendor_active,
      currency: row.currency, defaultLeadTimeDays: row.default_lead_time_days, minimumOrderCents: row.minimum_order_cents, freeFreightThresholdCents: row.free_freight_threshold_cents,
      revision: row.revision ?? 0, policy: row.policy ?? DEFAULT_SUPPLIER_SOURCING_POLICY });
    const candidates = byProduct.get(candidate.mapping.product_id) ?? [];
    candidates.push(candidate);
    if (candidates.length > SOURCING_MAX_CANDIDATES) throw new Error(`Product ${candidate.mapping.product_id} exceeds the ${SOURCING_MAX_CANDIDATES}-supplier evidence bound`);
    byProduct.set(candidate.mapping.product_id, candidates);
  }
  return rows.map((row) => ({ ...row, supplier_candidates: byProduct.get(Number(row.product_id)) ?? [] }));
}
