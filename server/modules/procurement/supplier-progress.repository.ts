import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { type SupplierProgress, type SupplierProgressReport } from "@shared/procurement/purchase-pipeline";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { pipelineProgress, pipelineRows, type PipelineDatabase, type PipelineTransaction } from "./purchase-pipeline.repository";

const lineSchema = z.object({ ordered: z.number().int().nonnegative().safe(), cancelled: z.number().int().nonnegative().safe(), lineType: z.string(), status: z.string(), purchaseStatus: z.string() });

class SupplierProgressTransaction {
  constructor(private readonly tx: PipelineTransaction) {}

  async findReplay(key: string): Promise<{ hash: string; progress: SupplierProgress } | null> {
    const rows = await pipelineRows(this.tx, sql`
      SELECT request_hash AS hash,revision,after_report AS report,recorded_by AS "recordedBy",recorded_at AS "recordedAt"
      FROM procurement.purchase_supplier_progress_revisions WHERE idempotency_key=${key}::uuid
    `, "progress request", 1);
    const row = rows[0];
    return row ? { hash: z.string().parse(row.hash), progress: pipelineProgress({ revision: row.revision, report: row.report, recordedBy: row.recordedBy, recordedAt: row.recordedAt }) } : null;
  }

  async lockLine(lineId: number): Promise<z.infer<typeof lineSchema> | null> {
    const identities = await pipelineRows(this.tx, sql`SELECT purchase_order_id AS id FROM procurement.purchase_order_lines WHERE id=${lineId}`, "progress purchase identity", 1);
    if (!identities[0]) return null;
    // Header before line agrees with the existing purchasing lifecycle owner.
    const purchases = await pipelineRows(this.tx, sql`SELECT id,status FROM procurement.purchase_orders WHERE id=${identities[0].id} FOR UPDATE`, "locked purchase", 1);
    const lines = await pipelineRows(this.tx, sql`SELECT order_qty AS ordered,COALESCE(cancelled_qty,0) AS cancelled,line_type AS "lineType",status FROM procurement.purchase_order_lines WHERE id=${lineId} AND purchase_order_id=${identities[0].id} FOR UPDATE`, "locked purchase line", 1);
    return lines[0] && purchases[0] ? lineSchema.parse({ ...lines[0], purchaseStatus: purchases[0].status }) : null;
  }

  async current(lineId: number): Promise<SupplierProgress> {
    const rows = await pipelineRows(this.tx, sql`SELECT revision,report,recorded_by AS "recordedBy",recorded_at AS "recordedAt" FROM procurement.purchase_supplier_progress WHERE purchase_order_line_id=${lineId} FOR UPDATE`, "locked progress", 1);
    return pipelineProgress(rows[0]);
  }

  async save(input: { lineId: number; key: string; hash: string; before: SupplierProgressReport | null; next: SupplierProgress; at: Date }): Promise<void> {
    await this.tx.execute(sql`
      INSERT INTO procurement.purchase_supplier_progress_revisions (purchase_order_line_id,revision,idempotency_key,request_hash,before_report,after_report,recorded_by,recorded_at)
      VALUES (${input.lineId},${input.next.revision},${input.key}::uuid,${input.hash},${input.before === null ? null : canonicalJson(input.before)}::jsonb,${canonicalJson(input.next.report)}::jsonb,${input.next.recordedBy},${input.at})
    `);
    await this.tx.execute(sql`
      INSERT INTO procurement.purchase_supplier_progress (purchase_order_line_id,revision,report,recorded_by,recorded_at)
      VALUES (${input.lineId},${input.next.revision},${canonicalJson(input.next.report)}::jsonb,${input.next.recordedBy},${input.at})
      ON CONFLICT (purchase_order_line_id) DO UPDATE SET revision=EXCLUDED.revision,report=EXCLUDED.report,recorded_by=EXCLUDED.recorded_by,recorded_at=EXCLUDED.recorded_at
    `);
  }
}

export class SupplierProgressRepository {
  constructor(private readonly database: PipelineDatabase) {}
  transaction<T>(work: (tx: SupplierProgressTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(async (tx) => {
      // A report has no physical/financial side effects, but must serialize its
      // source read with purchasing, shipment and receipt mutations.
      await lockInventoryCostGraph(tx);
      return work(new SupplierProgressTransaction(tx));
    });
  }
}
