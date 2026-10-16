import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db as defaultDb } from "../../db";
import type { AutoDraftPoAgingRow } from "./auto-draft-po-aging.service";
import { buildPoFinancialWorkflow } from "./domain/po-financial-workflow";
import {
  readPoFinancialEvidenceSourcesWithClient,
  PoFinancialEvidenceSourceError,
} from "./po-financial-evidence.repository";

export type AutoDraftPoAgingDatabase = Pick<typeof defaultDb, "transaction">;
const pageSizeSchema = z.number().int().min(1).max(1000);
const idSchema = z.number().int().positive().max(2_147_483_647);
// Raw node-postgres bigint columns arrive as decimal strings. Check the exact
// integer range before conversion; null, malformed, and unsafe values never
// become a rounded number or an invented zero.
const databaseCentsSchema = z.union([
  z.number().int().safe(),
  z
    .string()
    .regex(/^-?\d+$/)
    .refine((value) => {
      const amount = BigInt(value);
      return (
        amount >= BigInt(Number.MIN_SAFE_INTEGER) &&
        amount <= BigInt(Number.MAX_SAFE_INTEGER)
      );
    })
    .transform((value) => Number(value)),
]);
const dateSchema = z
  .union([
    z.date(),
    z.string().refine((value) => Number.isFinite(new Date(value).getTime())),
  ])
  .nullable();
const rowSchema = z
  .object({
    id: idSchema,
    poNumber: z.string(),
    vendorId: idSchema.nullable(),
    vendorName: z.string().nullable(),
    status: z.string().nullable(),
    physicalStatus: z.string().nullable(),
    financialStatus: z.string().nullable(),
    lineCount: z.number().int().nonnegative().nullable(),
    totalCents: databaseCentsSchema.nullable(),
    source: z.literal("auto_draft"),
    autoDraftDate: dateSchema,
    orderDate: dateSchema,
    approvedAt: dateSchema,
    sentToVendorAt: dateSchema,
    expectedDeliveryDate: dateSchema,
    confirmedDeliveryDate: dateSchema,
    actualDeliveryDate: dateSchema,
    firstShippedAt: dateSchema,
    firstArrivedAt: dateSchema,
    firstInvoicedAt: dateSchema,
    firstPaidAt: dateSchema,
    fullyPaidAt: dateSchema,
    createdAt: dateSchema,
    updatedAt: dateSchema,
    openExceptionCount: z.number().int().nonnegative(),
  })
  .strict();

/** Complete keyset traversal prevents recently updated, settled rows from hiding
 * older unresolved POs. pageSize bounds each query, not the total diagnostic count.
 * Candidate rows and financial evidence share one coherent read-only snapshot. */
export async function fetchAutoDraftPoAgingRows(
  database: AutoDraftPoAgingDatabase,
  options: {
    pageSize?: number;
    /** @deprecated Use pageSize; this is no longer a total scan cap. */ scanLimit?: number;
  } = {},
): Promise<AutoDraftPoAgingRow[]> {
  const pageSize = pageSizeSchema.parse(
    options.pageSize ?? options.scanLimit ?? 500,
  );
  return database.transaction(
    async (tx) => {
      const rows: AutoDraftPoAgingRow[] = [];
      let afterId = 0;
      for (;;) {
        const result = await tx.execute(sql`
        SELECT po.id, po.po_number AS "poNumber", po.vendor_id AS "vendorId", v.name AS "vendorName",
          po.status, po.physical_status AS "physicalStatus", po.financial_status AS "financialStatus",
          po.line_count AS "lineCount", po.total_cents AS "totalCents", po.source,
          po.auto_draft_date AS "autoDraftDate", po.order_date AS "orderDate", po.approved_at AS "approvedAt",
          po.sent_to_vendor_at AS "sentToVendorAt", po.expected_delivery_date AS "expectedDeliveryDate",
          po.confirmed_delivery_date AS "confirmedDeliveryDate", po.actual_delivery_date AS "actualDeliveryDate",
          po.first_shipped_at AS "firstShippedAt", po.first_arrived_at AS "firstArrivedAt",
          po.first_invoiced_at AS "firstInvoicedAt", po.first_paid_at AS "firstPaidAt", po.fully_paid_at AS "fullyPaidAt",
          po.created_at AS "createdAt", po.updated_at AS "updatedAt",
          (SELECT COUNT(*)::int FROM procurement.po_exceptions e
            WHERE e.po_id = po.id AND e.status IN ('open', 'acknowledged')) AS "openExceptionCount"
        FROM procurement.purchase_orders po
        LEFT JOIN procurement.vendors v ON v.id = po.vendor_id
        WHERE po.source = 'auto_draft' AND po.id > ${afterId}
        ORDER BY po.id ASC
        LIMIT ${pageSize}
      `);
        const page = z.array(rowSchema).parse(result.rows);
        if (page.length === 0) break;
        const sources = await readPoFinancialEvidenceSourcesWithClient(
          tx,
          page.map((row) => row.id),
        );
        for (const row of page) {
          const source = sources.get(row.id);
          if (!source) throw new PoFinancialEvidenceSourceError();
          const financialWorkflow = buildPoFinancialWorkflow(source);
          const verifiedClosed =
            row.status === "closed" &&
            ["received", "short_closed"].includes(row.physicalStatus ?? "") &&
            financialWorkflow.state === "settled" &&
            row.openExceptionCount === 0;
          // Cancellation ends physical work, not a linked invoice's obligation.
          // Only hide a cancelled PO after current evidence proves no AP work and
          // no open exception remains; legacy status alone is insufficient.
          const verifiedCancelled =
            (row.status === "cancelled" ||
              row.physicalStatus === "cancelled") &&
            ["unbilled", "settled"].includes(financialWorkflow.state) &&
            row.openExceptionCount === 0;
          if (!verifiedClosed && !verifiedCancelled)
            rows.push({ ...row, financialWorkflow });
        }
        const lastId = page[page.length - 1].id;
        if (lastId <= afterId)
          throw new Error(
            "Auto-draft financial review traversal did not advance.",
          );
        afterId = lastId;
        if (page.length < pageSize) break;
      }
      return rows;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
