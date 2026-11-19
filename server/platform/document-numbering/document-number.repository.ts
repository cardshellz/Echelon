import { sql, type SQL } from "drizzle-orm";
import { nextDocumentNumber } from "./document-number";

export interface DocumentNumberExecutor {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

type DocumentKind = "purchase_order" | "receipt" | "payment" | "lot";
interface NumberSource { table: SQL; column: SQL; label: string; maxLength: number }
// Identifiers are fixed here, never supplied by a request or interpolated as SQL text.
// Lengths match the persisted schema; all owners retain their existing width of three.
const SOURCES: Readonly<Record<DocumentKind | "invoice_suggestion", NumberSource>> = {
  purchase_order: { table: sql`procurement.purchase_orders`, column: sql`po_number`, label: "PO", maxLength: 30 },
  receipt: { table: sql`procurement.receiving_orders`, column: sql`receipt_number`, label: "RCV", maxLength: 50 },
  payment: { table: sql`procurement.ap_payments`, column: sql`payment_number`, label: "PAY", maxLength: 30 },
  lot: { table: sql`inventory.inventory_lots`, column: sql`lot_number`, label: "LOT", maxLength: 50 },
  invoice_suggestion: { table: sql`procurement.vendor_invoices`, column: sql`invoice_number`, label: "INV", maxLength: 100 },
};

const ALLOCATION_LOCKS: Readonly<Record<DocumentKind, SQL>> = {
  purchase_order: sql`SELECT pg_advisory_xact_lock(hashtext('document_number.purchase_order'), hashtext('version_1'))`,
  // Retain existing lock identities so in-flight receipt/payment writers from
  // the previous release still serialize with this allocator during deployment.
  receipt: sql`SELECT pg_advisory_xact_lock(hashtext('procurement.generate_receipt_number'))`,
  payment: sql`SELECT pg_advisory_xact_lock(hashtext('ap_payment_number'))`,
  lot: sql`SELECT pg_advisory_xact_lock(hashtext('document_number.lot'), hashtext('version_1'))`,
};

function sourceFor(kind: keyof typeof SOURCES, prefix: string): NumberSource {
  const source = SOURCES[kind];
  if (!source || !new RegExp(`^${source.label}-[0-9]{8}-$`).test(prefix)) {
    throw new TypeError("Document numbering source and prefix do not match");
  }
  return source;
}

async function readNextNumber(executor: DocumentNumberExecutor, source: NumberSource, prefix: string): Promise<string> {
  // Include cancelled/voided rows so their identifiers are never automatically
  // reused. Custom references are not sequence evidence. The CASE guards the cast
  // independently of query-plan predicate order, and numeric preserves all digits.
  const pattern = `^${prefix}[0-9]+$`;
  const result = await executor.execute(sql`
    SELECT MAX(CASE WHEN ${source.column} ~ ${pattern}
      THEN substring(${source.column} FROM ${prefix.length + 1}::integer)::numeric END)::text AS suffix
    FROM ${source.table}
    WHERE ${source.column} LIKE ${`${prefix}%`}
  `);
  if (result.rows.length !== 1 || (result.rows[0].suffix !== null && typeof result.rows[0].suffix !== "string")) {
    throw new TypeError("Document numbering evidence is missing or invalid");
  }
  return nextDocumentNumber(prefix, result.rows[0].suffix as string | null, source.maxLength);
}

/** Caller must keep this transaction open through the corresponding insert. */
export async function allocateDocumentNumber(tx: DocumentNumberExecutor, input: { kind: DocumentKind; prefix: string }): Promise<string> {
  const source = sourceFor(input.kind, input.prefix);
  // Graph-owning callers acquire their graph lock first. A namespace-wide lock
  // also serializes creators straddling midnight without changing existing IDs.
  await tx.execute(ALLOCATION_LOCKS[input.kind]);
  return readNextNumber(tx, source, input.prefix);
}

/** An editable supplier-reference suggestion, never a reservation or a write. */
export async function readSuggestedInvoiceNumber(executor: DocumentNumberExecutor, prefix: string): Promise<string> {
  return readNextNumber(executor, sourceFor("invoice_suggestion", prefix), prefix);
}
