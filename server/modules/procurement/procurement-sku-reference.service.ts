import {
  inboundShipmentLines,
  purchaseOrderLines,
  receivingLines,
  vendorInvoiceLines,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { persistAuditEvent } from "../../infrastructure/auditLogger";

const MAX_SKU_LENGTH = 100;

export type ProcurementSkuReferenceRename = {
  productVariantId: number;
  oldSku: string;
  newSku: string;
  actor: string;
};

export type ProcurementSkuReferenceRenameResult = {
  purchaseOrderLines: number;
  inboundShipmentLines: number;
  receivingLines: number;
  vendorInvoiceLines: number;
};

type CommandExecutor = Pick<typeof db, "update" | "insert">;
type TransactionalDatabase = Pick<typeof db, "transaction">;

export class ProcurementSkuReferenceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ProcurementSkuReferenceError";
  }
}

function normalizeInput(input: ProcurementSkuReferenceRename): ProcurementSkuReferenceRename {
  if (!Number.isSafeInteger(input.productVariantId) || input.productVariantId <= 0) {
    throw new ProcurementSkuReferenceError("Product variant id must be a positive safe integer");
  }

  const oldSku = input.oldSku.trim();
  const newSku = input.newSku.trim();
  const actor = input.actor.trim();
  if (!oldSku || !newSku) {
    throw new ProcurementSkuReferenceError("Old and new SKU values are required");
  }
  if (oldSku.length > MAX_SKU_LENGTH || newSku.length > MAX_SKU_LENGTH) {
    throw new ProcurementSkuReferenceError(`SKU values cannot exceed ${MAX_SKU_LENGTH} characters`);
  }
  if (oldSku === newSku) {
    throw new ProcurementSkuReferenceError("Old and new SKU values must differ");
  }
  if (!actor) {
    throw new ProcurementSkuReferenceError("An attributable actor is required");
  }

  return { ...input, oldSku, newSku, actor };
}

async function applyRename(
  executor: CommandExecutor,
  input: ProcurementSkuReferenceRename,
  changedAt: Date,
): Promise<ProcurementSkuReferenceRenameResult> {
  const poRows = await executor
    .update(purchaseOrderLines)
    .set({ sku: input.newSku, updatedAt: changedAt })
    .where(eq(purchaseOrderLines.productVariantId, input.productVariantId))
    .returning({ id: purchaseOrderLines.id });
  const shipmentRows = await executor
    .update(inboundShipmentLines)
    .set({ sku: input.newSku, updatedAt: changedAt })
    .where(eq(inboundShipmentLines.productVariantId, input.productVariantId))
    .returning({ id: inboundShipmentLines.id });
  const receiptRows = await executor
    .update(receivingLines)
    .set({ sku: input.newSku, updatedAt: changedAt })
    .where(eq(receivingLines.productVariantId, input.productVariantId))
    .returning({ id: receivingLines.id });
  const invoiceRows = await executor
    .update(vendorInvoiceLines)
    .set({ sku: input.newSku, updatedAt: changedAt })
    .where(eq(vendorInvoiceLines.productVariantId, input.productVariantId))
    .returning({ id: vendorInvoiceLines.id });

  const result: ProcurementSkuReferenceRenameResult = {
    purchaseOrderLines: poRows.length,
    inboundShipmentLines: shipmentRows.length,
    receivingLines: receiptRows.length,
    vendorInvoiceLines: invoiceRows.length,
  };

  await persistAuditEvent(executor, {
    actor: input.actor,
    action: "procurement.sku_reference.rename",
    target: `catalog.product_variant:${input.productVariantId}`,
    changes: {
      before: { sku: input.oldSku },
      after: { sku: input.newSku },
    },
    context: {
      productVariantId: input.productVariantId,
      affectedRows: result,
    },
  }, {
    timestamp: changedAt,
    emitStructuredLog: false,
  });

  return result;
}

export async function synchronizeProcurementSkuReferences(
  rawInput: ProcurementSkuReferenceRename,
  options: {
    executor?: CommandExecutor;
    database?: TransactionalDatabase;
    now?: () => Date;
  } = {},
): Promise<ProcurementSkuReferenceRenameResult> {
  const input = normalizeInput(rawInput);
  const changedAt = (options.now ?? (() => new Date()))();
  if (!(changedAt instanceof Date) || Number.isNaN(changedAt.getTime())) {
    throw new ProcurementSkuReferenceError("SKU reference change timestamp is invalid");
  }

  if (options.executor) {
    return await applyRename(options.executor, input, changedAt);
  }

  const database = options.database ?? db;
  return await database.transaction(async (tx) => await applyRename(tx, input, changedAt));
}
