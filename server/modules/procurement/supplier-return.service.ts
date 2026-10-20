import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db";
import {
  supplierReturnDetailSchema, supplierReturnListQuerySchema, supplierReturnOptionsQuerySchema,
  supplierReturnPreviewInputSchema, supplierReturnRecordInputSchema,
  type SupplierReturnDetail,
} from "@shared/procurement/supplier-return";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import {
  previewSupplierReturnStock, executeSupplierReturnStock, readSupplierReturnStockOptions,
  readSupplierReturnInventoryEvidenceBatch,
} from "../inventory/application/supplier-return-stock";
import {
  insertSupplierReturnDocument, listSupplierReturnIds, readSupplierReturnRecords, type SupplierReturnTransaction,
} from "./supplier-return.repository";
import { readSupplierReturnCreditStates } from "./supplier-return-credit.repository";
import { projectSupplierReturnList } from "./supplier-return-read.domain";
import { SupplierReturnError } from "./supplier-return.errors";
import { createSupplierReturnReport, supplierReturnReportSchema } from "@shared/procurement/supplier-return-report";
import { canonicalJson } from "@shared/utils/canonical-json";
export type { SupplierReturnTransaction } from "./supplier-return.repository";

export async function assertSupplierReturnAuthority(tx: SupplierReturnTransaction, actorId: string, mode: "read" | "record") {
  if (!actorId?.trim()) throw new SupplierReturnError("SUPPLIER_RETURN_AUTHORITY_REQUIRED", "An authenticated purchasing operator is required.", 403);
  const authority = await readCommandAuthorityActor(tx, actorId, { lock: mode === "record" });
  const permission = mode === "record" ? "purchasing:approve" : "purchasing:view";
  if (!authority.active || !authority.permissions.includes(permission)) {
    throw new SupplierReturnError("SUPPLIER_RETURN_AUTHORITY_REQUIRED", `Current ${permission} permission is required.`, 403);
  }
}

/** Every screen consumes the same current inventory/value and credit evidence.
 * The caller supplies a repeatable-read snapshot or the locked write TX. */
async function readDetails(tx: SupplierReturnTransaction, ids: readonly number[], requireReport: boolean): Promise<SupplierReturnDetail[]> {
  const records = await readSupplierReturnRecords(tx, ids);
  if (records.headers.length === 0) return [];
  const inventory = await readSupplierReturnInventoryEvidenceBatch(tx, records.headers.map(header => header.id));
  const credits: Awaited<ReturnType<typeof readSupplierReturnCreditStates>> = new Map();
  // A valid page may contain 100 documents with 100 lines each; honor the
  // credit reader's bounded 1,000-line batches without truncating the page.
  for (let start = 0; start < records.lines.length; start += 1000) {
    const batch = await readSupplierReturnCreditStates(tx, records.lines.slice(start, start + 1000).map(line => line.id));
    for (const [lineId, evidence] of batch) credits.set(lineId, evidence);
  }
  return records.headers.map(header => {
    const value = inventory.get(header.id);
    if (!value) throw new Error("Supplier return has no complete inventory evidence");
    const document = supplierReturnDetailSchema.parse({
      id: header.id, vendorId: header.vendor_id, vendorName: header.vendor_name, status: "recorded",
      supplierReference: header.supplier_reference, returnCalendarDate: header.return_calendar_date,
      evidenceReference: header.evidence_reference, reason: header.reason, sourceFingerprint: header.source_fingerprint,
      recordedBy: header.recorded_by, recordedAt: header.recorded_at.toISOString(), inventoryReceipt: value.receipt,
      lines: records.lines.filter(line => line.supplier_return_id === header.id).map(line => {
        const current = value.lines.find(item => item.returnLineId === line.id);
        const credit = credits.get(line.id);
        if (!current || !credit) throw new Error("Supplier return line lacks complete cost or credit evidence");
        return { id: line.id, source: line.source_snapshot, currentCosts: current.currentCosts, costEntries: current.costEntries,
          creditState: credit.creditState, creditIssues: credit.creditIssues, creditLinks: credit.creditLinks, sourceInvoices: credit.sourceInvoices };
      }),
    });
    if (requireReport) {
      const events = records.reports.filter(event => event.supplier_return_id === header.id);
      if (events.length !== 1 || events[0].contract_version !== 1
        || canonicalJson(supplierReturnReportSchema.parse(events[0].payload)) !== canonicalJson(createSupplierReturnReport(document))) {
        throw new Error("Supplier return physical reporting evidence does not match its immutable collection");
      }
    }
    return document;
  });
}
export function readSupplierReturnDetails(tx: SupplierReturnTransaction, ids: readonly number[]): Promise<SupplierReturnDetail[]> {
  return readDetails(tx, ids, true);
}

export async function recordSupplierReturn(tx: SupplierReturnTransaction, input: {
  raw: unknown; actorId: string; at: Date; commandKey: string; requestFingerprint: string;
}): Promise<SupplierReturnDetail> {
  const parsed = supplierReturnRecordInputSchema.safeParse(input.raw);
  if (!parsed.success) throw new SupplierReturnError("SUPPLIER_RETURN_INPUT_INVALID", "Review the return source, quantities, date and collection evidence.", 422);
  if (!(input.at instanceof Date) || !Number.isFinite(input.at.getTime())) throw new Error("Supplier return requires a valid injected clock");
  const request = parsed.data;
  let inserted = false;
  const receipt = await executeSupplierReturnStock(tx, {
    vendorId: request.vendorId, lines: request.lines, expectedSourceFingerprint: request.expectedSourceFingerprint,
    actorId: input.actorId, at: input.at, commandKey: input.commandKey, requestFingerprint: input.requestFingerprint, reason: request.reason,
    assertAuthority: () => assertSupplierReturnAuthority(tx, input.actorId, "record"),
    createDocument: async preview => {
      if (inserted) throw new Error("A supplier return command attempted to create more than one document");
      const document = await insertSupplierReturnDocument(tx, { ...input, request, preview });
      inserted = true;
      return document;
    },
  });
  const [document] = await readDetails(tx, [receipt.returnId], !inserted);
  if (!document) throw new Error("Recorded supplier return disappeared in its transaction");
  if (receipt.replayed === inserted) throw new Error("Supplier return execution and document creation disagree");
  if (inserted) {
    const report = createSupplierReturnReport(document);
    await tx.execute(sql`INSERT INTO procurement.supplier_return_reporting_events(supplier_return_id,contract_version,payload,recorded_at)
      VALUES(${document.id},1,${canonicalJson(report)}::jsonb,${input.at})`);
    await tx.execute(sql`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES(${input.at},'AUDIT',${input.actorId},'procurement.supplier_return.record',${`supplier-return:${document.id}`},
        ${canonicalJson({ before: null, after: document })}::jsonb,
        ${canonicalJson({ command: "record", commandKey: input.commandKey, request, inventoryReceipt: receipt })}::jsonb)`);
  }
  return document;
}

type ReturnDatabase = Pick<typeof db, "transaction">;
export function createSupplierReturnReader(database: ReturnDatabase = db) {
  async function read<T>(actorId: string, work: (tx: SupplierReturnTransaction) => Promise<T>): Promise<T> {
    return database.transaction(async tx => {
      await assertSupplierReturnAuthority(tx, actorId, "read");
      return work(tx);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  return {
    preview: (raw: unknown, actorId: string) => read(actorId, tx => previewSupplierReturnStock(tx, supplierReturnPreviewInputSchema.parse(raw))),
    options: (raw: unknown, actorId: string) => read(actorId, tx => readSupplierReturnStockOptions(tx, supplierReturnOptionsQuerySchema.parse(raw))),
    detail: (rawId: number, actorId: string) => read(actorId, async tx => {
      const id = z.number().int().positive().safe().parse(rawId);
      return (await readSupplierReturnDetails(tx, [id]))[0];
    }),
    list: (raw: unknown, actorId: string) => read(actorId, async tx => {
      const query = supplierReturnListQuerySchema.parse(raw);
      const page = await listSupplierReturnIds(tx, query);
      const documents = await readSupplierReturnDetails(tx, page.ids);
      return projectSupplierReturnList(documents, page.nextAfterId);
    }),
  };
}
export const supplierReturnReader = createSupplierReturnReader();
