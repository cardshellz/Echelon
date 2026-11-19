import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import {
  returnParcelReceivingSchema,
  returnParcelReceiptResultSchema,
  type ReturnParcelReceiving,
} from "@shared/returns/return-parcel-receiving.contract";
import { ReturnCaseOperationError } from "../application/return-case-operations.service";
import type {
  ReturnParcelReceivingAllocation,
  ReturnParcelReceivingStore,
  ReturnParcelReceivingTransaction,
} from "../application/return-parcel-receiving.service";
import {
  PostgresReturnCaseOperationTransaction,
  RETURN_QUANTITY_LOCK_NAMESPACE,
} from "./return-case-operation.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const id = z.coerce.number().int().positive().safe();
const quantity = z.coerce.number().int().nonnegative().safe();
function rows(result: unknown): Record<string, unknown>[] {
  return z.object({ rows: z.array(z.record(z.unknown())) }).parse(result).rows;
}

export class PostgresReturnParcelReceivingStore
  implements ReturnParcelReceivingStore
{
  transaction<T>(
    work: (tx: ReturnParcelReceivingTransaction) => Promise<T>,
  ): Promise<T> {
    return db.transaction((tx) =>
      work(new PostgresReturnParcelReceivingTransaction(tx)),
    );
  }
  lookupLabel(label: string): Promise<ReturnParcelReceiving> {
    // Exact label identity, not fuzzy RMA search. Duplicate carrier tracking
    // numbers must be resolved explicitly rather than selecting the first match.
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      );
      const matches = rows(
        await tx.execute(sql`SELECT DISTINCT p.id FROM returns.customer_return_parcels p
        JOIN returns.customer_return_label_attempts t ON t.parcel_id=p.id AND t.status='succeeded'
        WHERE UPPER(regexp_replace(t.result_snapshot->>'trackingNumber','[^a-zA-Z0-9]','','g'))=
          UPPER(regexp_replace(${label},'[^a-zA-Z0-9]','','g')) ORDER BY p.id LIMIT 2`),
      );
      if (matches.length !== 1)
        throw new ReturnCaseOperationError(
          matches.length === 0
            ? "RETURN_PARCEL_LABEL_NOT_FOUND"
            : "RETURN_PARCEL_LABEL_AMBIGUOUS",
          matches.length === 0
            ? "No return box matches this label. Check the return tracking number."
            : "This label matches multiple return boxes. Contact a supervisor to verify it.",
          409,
        );
      return (
        await new PostgresReturnParcelReceivingTransaction(tx).load(
          id.parse(matches[0].id),
          false,
        )
      ).parcel;
    });
  }
}

class PostgresReturnParcelReceivingTransaction
  implements ReturnParcelReceivingTransaction
{
  readonly caseOperations: PostgresReturnCaseOperationTransaction;
  constructor(private readonly tx: Transaction) {
    this.caseOperations = new PostgresReturnCaseOperationTransaction(tx);
  }
  async lockCommand(key: string): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`return-parcel-receipt:${key}`},0))`,
    );
  }
  async findCommand(key: string) {
    const row = rows(
      await this.tx.execute(
        sql`SELECT parcel_id,request_hash,response FROM returns.customer_return_parcel_receipts WHERE idempotency_key=${key}::uuid`,
      ),
    )[0];
    return row
      ? {
          parcelId: id.parse(row.parcel_id),
          hash: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(row.request_hash),
          result: returnParcelReceiptResultSchema.parse(row.response),
        }
      : null;
  }
  async load(parcelId: number, lock = true) {
    const identity = rows(
      await this.tx
        .execute(sql`SELECT a.oms_order_id FROM returns.customer_return_parcels p
      JOIN returns.customer_return_authorizations a ON a.id=p.authorization_id WHERE p.id=${parcelId}`),
    )[0];
    if (!identity)
      throw new ReturnCaseOperationError(
        "RETURN_PARCEL_NOT_FOUND",
        "This return box was not found.",
        404,
      );
    const orderId = id.parse(identity.oms_order_id);
    // Same quantity owner and lock order as case receiving; all mixed case
    // updates, the parcel ledger, and their audit events commit together.
    if (lock && orderId <= 2_147_483_647)
      await this.tx.execute(
        sql`SELECT pg_advisory_xact_lock(${RETURN_QUANTITY_LOCK_NAMESPACE},${orderId})`,
      );
    if (lock)
      await this.tx.execute(
        sql`SELECT id FROM oms.oms_orders WHERE id=${orderId} FOR UPDATE`,
      );
    const parent = rows(
      await this.tx
        .execute(sql`SELECT p.id,p.authorization_id,p.parcel_key,a.authorization_number,
      t.result_snapshot->>'trackingNumber' AS tracking_number FROM returns.customer_return_parcels p
      JOIN returns.customer_return_authorizations a ON a.id=p.authorization_id
      JOIN returns.customer_return_label_attempts t ON t.parcel_id=p.id AND t.status='succeeded'
      WHERE p.id=${parcelId} ${lock ? sql`FOR UPDATE OF p` : sql``}`),
    );
    if (parent.length !== 1)
      throw new ReturnCaseOperationError(
        "RETURN_PARCEL_LABEL_NOT_READY",
        "Verify this box's purchased return label before receiving it.",
        409,
      );
    const authorizationId = id.parse(parent[0].authorization_id);
    const lines = rows(
      await this.tx.execute(sql`SELECT al.id,ol.title,ol.sku,manifest.quantity,
      COALESCE((SELECT sum(r.quantity) FROM returns.customer_return_parcel_receipt_allocations r
        JOIN returns.customer_return_authorization_allocations aa ON aa.id=r.allocation_id
        WHERE r.parcel_id=manifest.parcel_id AND aa.authorization_line_id=al.id),0)::text AS received
      FROM returns.customer_return_parcel_items manifest
      JOIN returns.customer_return_authorization_lines al ON al.id=manifest.authorization_line_id
      JOIN oms.oms_order_lines ol ON ol.id=al.oms_order_line_id
      WHERE manifest.parcel_id=${parcelId} ORDER BY al.id`),
    );
    const parcel = returnParcelReceivingSchema.parse({
      parcelId,
      authorizationId,
      authorizationNumber: parent[0].authorization_number,
      boxNumber: id.parse(parent[0].parcel_key),
      trackingNumber: parent[0].tracking_number,
      lines: lines.map((line) => ({
        authorizationLineId: id.parse(line.id),
        title: line.title,
        sku: line.sku,
        expectedQuantity: id.parse(line.quantity),
        receivedQuantity: quantity.parse(line.received),
      })),
    });
    const source = rows(
      await this.tx
        .execute(sql`SELECT aa.id,aa.authorization_line_id,aa.quantity,ci.case_item_id,rc.return_case_id,
      ri.received_qty,COALESCE((SELECT sum(r.quantity) FROM returns.customer_return_parcel_receipt_allocations r WHERE r.allocation_id=aa.id),0)::text AS received
      FROM returns.customer_return_authorization_allocations aa
      JOIN returns.customer_return_allocation_case_items ci ON ci.authorization_allocation_id=aa.id
      JOIN returns.return_case_items rc ON rc.id=ci.case_item_id
      JOIN wms.return_items ri ON ri.id=ci.wms_return_item_id
      WHERE aa.authorization_id=${authorizationId} ORDER BY aa.id`),
    );
    const allocations: ReturnParcelReceivingAllocation[] = source.map(
      (row) => ({
        allocationId: id.parse(row.id),
        authorizationLineId: id.parse(row.authorization_line_id),
        caseId: id.parse(row.return_case_id),
        caseItemId: id.parse(row.case_item_id),
        quantity: id.parse(row.quantity),
        receivedByLabelQuantity: quantity.parse(row.received),
        caseReceivedQuantity: quantity.parse(row.received_qty),
      }),
    );
    return { parcel, allocations };
  }
  async save(
    input: Parameters<ReturnParcelReceivingTransaction["save"]>[0],
  ): Promise<void> {
    const saved = rows(
      await this.tx
        .execute(sql`INSERT INTO returns.customer_return_parcel_receipts
      (parcel_id,idempotency_key,request_hash,response,actor,notes,received_at)
      VALUES(${input.parcelId},${input.key}::uuid,${input.hash},${JSON.stringify(input.result)}::jsonb,${input.actor},${input.notes},${input.now}) RETURNING id`),
    )[0];
    const receiptId = id.parse(saved?.id);
    for (const allocation of input.allocations)
      await this.tx
        .execute(sql`INSERT INTO returns.customer_return_parcel_receipt_allocations
      (receipt_id,parcel_id,allocation_id,case_item_id,quantity) VALUES(${receiptId},${input.parcelId},${allocation.allocationId},${allocation.caseItemId},${allocation.quantity})`);
  }
}
