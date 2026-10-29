import { createHash } from "node:crypto";
import { z } from "zod";
import {
  returnParcelReceiptInputSchema,
  returnParcelReceivingSchema,
  returnParcelReceiptResultSchema,
  type ReturnParcelReceiving,
  type ReturnParcelReceiptResult,
} from "@shared/returns/return-parcel-receiving.contract";
import {
  ReturnCaseOperationService,
  ReturnCaseOperationError,
  type ReturnCaseOperationTransaction,
} from "./return-case-operations.service";

export interface ReturnParcelReceivingAllocation {
  allocationId: number;
  authorizationLineId: number;
  caseId: number;
  caseItemId: number;
  quantity: number;
  receivedByLabelQuantity: number;
  caseReceivedQuantity: number;
}
export interface ReturnParcelReceivingTransaction {
  caseOperations: ReturnCaseOperationTransaction;
  lockCommand(key: string): Promise<void>;
  findCommand(key: string): Promise<{
    parcelId: number;
    hash: string;
    result: ReturnParcelReceiptResult;
  } | null>;
  load(parcelId: number): Promise<{
    parcel: ReturnParcelReceiving;
    allocations: ReturnParcelReceivingAllocation[];
  }>;
  save(input: {
    parcelId: number;
    key: string;
    hash: string;
    actor: string;
    notes: string | null;
    now: Date;
    allocations: {
      allocationId: number;
      caseItemId: number;
      quantity: number;
    }[];
    result: ReturnParcelReceiptResult;
  }): Promise<void>;
}
export interface ReturnParcelReceivingStore {
  lookupLabel(label: string): Promise<ReturnParcelReceiving>;
  transaction<T>(
    work: (tx: ReturnParcelReceivingTransaction) => Promise<T>,
  ): Promise<T>;
}

/** One atomic box receipt routes purchased-line quantities through the existing
 * case receipt commands. No restock, inventory treatment, inspection, or refund.
 */
export class ReturnParcelReceivingService {
  constructor(
    private readonly store: ReturnParcelReceivingStore,
    private readonly clock: () => Date,
  ) {}

  async lookup(label: unknown): Promise<ReturnParcelReceiving> {
    return returnParcelReceivingSchema.parse(
      await this.store.lookupLabel(
        z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine((value) => /[A-Za-z0-9]/.test(value))
          .parse(label),
      ),
    );
  }

  async receive(
    parcelId: number,
    raw: unknown,
    actor: string,
  ): Promise<ReturnParcelReceiptResult> {
    z.number().int().positive().safe().parse(parcelId);
    const checkedActor = z.string().trim().min(1).max(255).parse(actor);
    const parsed = returnParcelReceiptInputSchema.parse(raw);
    const input = {
      ...parsed,
      lines: [...parsed.lines].sort(
        (a, b) => a.authorizationLineId - b.authorizationLineId,
      ),
    };
    if (
      new Set(input.lines.map((line) => line.authorizationLineId)).size !==
      input.lines.length
    )
      invalid();
    const hash = createHash("sha256")
      .update(JSON.stringify({ parcelId, ...input }))
      .digest("hex");
    return this.store.transaction(async (tx) => {
      await tx.lockCommand(input.idempotencyKey);
      const replay = await tx.findCommand(input.idempotencyKey);
      if (replay) {
        if (replay.parcelId !== parcelId || replay.hash !== hash)
          throw new ReturnCaseOperationError(
            "RETURN_PARCEL_RECEIPT_COMMAND_CONFLICT",
            "This receipt key was already used for different box quantities.",
            409,
          );
        return returnParcelReceiptResultSchema.parse({
          ...replay.result,
          replayed: true,
        });
      }
      const { parcel, allocations } = await tx.load(parcelId);
      returnParcelReceivingSchema.parse(parcel);
      const byCaseItem = new Map<number, ReturnParcelReceivingAllocation[]>();
      for (const allocation of allocations) {
        if (
          !Number.isSafeInteger(allocation.quantity) ||
          allocation.quantity < 1 ||
          !Number.isSafeInteger(allocation.receivedByLabelQuantity) ||
          allocation.receivedByLabelQuantity < 0 ||
          allocation.receivedByLabelQuantity > allocation.quantity
        )
          invalid();
        byCaseItem.set(allocation.caseItemId, [
          ...(byCaseItem.get(allocation.caseItemId) ?? []),
          allocation,
        ]);
      }
      for (const rows of byCaseItem.values()) {
        if (
          rows.reduce((sum, row) => sum + row.receivedByLabelQuantity, 0) !==
          rows[0].caseReceivedQuantity
        ) {
          throw new ReturnCaseOperationError(
            "RETURN_PARCEL_RECEIPT_RECONCILIATION_REQUIRED",
            "Some items were received outside the box workflow. Review those receipts before receiving this label.",
            409,
          );
        }
      }
      const routing: {
        allocationId: number;
        caseItemId: number;
        quantity: number;
        caseId: number;
      }[] = [];
      for (const line of input.lines) {
        const manifest = parcel.lines.find(
          (item) => item.authorizationLineId === line.authorizationLineId,
        );
        if (!manifest) invalid();
        if (manifest.receivedQuantity !== line.expectedCurrentReceivedQuantity)
          throw new ReturnCaseOperationError(
            "RETURN_PARCEL_RECEIPT_STALE",
            "This box's received quantities changed. Scan the label again before continuing.",
            409,
          );
        if (
          line.quantityReceivedNow >
          manifest.expectedQuantity - manifest.receivedQuantity
        )
          invalid();
        let left = line.quantityReceivedNow;
        for (const allocation of allocations
          .filter(
            (item) => item.authorizationLineId === line.authorizationLineId,
          )
          .sort((a, b) => a.allocationId - b.allocationId)) {
          const quantity = Math.min(
            left,
            allocation.quantity - allocation.receivedByLabelQuantity,
          );
          if (quantity > 0)
            routing.push({
              allocationId: allocation.allocationId,
              caseItemId: allocation.caseItemId,
              caseId: allocation.caseId,
              quantity,
            });
          left -= quantity;
        }
        if (left !== 0) invalid();
      }
      const caseIds = [...new Set(routing.map((item) => item.caseId))].sort(
        (a, b) => a - b,
      );
      const operations = new ReturnCaseOperationService(
        { transaction: (work) => work(tx.caseOperations) },
        this.clock,
      );
      for (const caseId of caseIds) {
        const lines = new Map<
          number,
          {
            returnCaseItemId: number;
            expectedCurrentReceivedQuantity: number;
            quantityReceivedNow: number;
          }
        >();
        for (const row of routing.filter((item) => item.caseId === caseId)) {
          const previous = lines.get(row.caseItemId);
          lines.set(row.caseItemId, {
            returnCaseItemId: row.caseItemId,
            expectedCurrentReceivedQuantity: allocations.find(
              (item) => item.caseItemId === row.caseItemId,
            )!.caseReceivedQuantity,
            quantityReceivedNow:
              (previous?.quantityReceivedNow ?? 0) + row.quantity,
          });
        }
        await operations.recordReceipt({
          caseId,
          idempotencyKey: `parcel-receipt:${input.idempotencyKey}:${caseId}`,
          actor: checkedActor,
          notes: input.notes,
          lines: [...lines.values()].sort(
            (a, b) => a.returnCaseItemId - b.returnCaseItemId,
          ),
        });
      }
      const result = returnParcelReceiptResultSchema.parse({
        parcel: {
          ...parcel,
          lines: parcel.lines.map((line) => ({
            ...line,
            receivedQuantity:
              line.receivedQuantity +
              (input.lines.find(
                (item) => item.authorizationLineId === line.authorizationLineId,
              )?.quantityReceivedNow ?? 0),
          })),
        },
        caseIds,
        replayed: false,
      });
      await tx.save({
        parcelId,
        key: input.idempotencyKey,
        hash,
        actor: checkedActor,
        notes: input.notes,
        now: z.date().parse(this.clock()),
        allocations: routing.map(({ allocationId, caseItemId, quantity }) => ({
          allocationId,
          caseItemId,
          quantity,
        })),
        result,
      });
      return result;
    });
  }
}
function invalid(): never {
  throw new ReturnCaseOperationError(
    "RETURN_PARCEL_RECEIPT_QUANTITY_INVALID",
    "Enter only the items and quantities still expected in this return box.",
    409,
  );
}
