import { z } from "zod";
import { paymentCalendarDateSchema } from "./ap-payment-contract";
const id = z.number().int().positive().safe();
// Incoming identities stored as PostgreSQL integer must fail before a SQL cast.
// Retained allocation and value-entry identities use bigint and keep safe-integer bounds.
const inputId = id.max(2_147_483_647);
const queryId = z.coerce.number().int().positive().max(2_147_483_647);
const quantity = z.number().int().positive().max(2147483647);
const nonnegative = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const SUPPLIER_RETURN_MAX_REASON_LENGTH = 1000;
const reason = z.string().trim().min(3).max(SUPPLIER_RETURN_MAX_REASON_LENGTH);
export const supplierReturnIssueSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict();
export const supplierReturnComponentSchema = z.enum(["product", "packaging", "landed"]);
export const supplierReturnCostTotalsSchema = z.object({
    productMills: nonnegative, packagingMills: nonnegative, landedMills: nonnegative, totalMills: nonnegative,
}).strict().superRefine((value, context) => {
    if (!Object.values(value).every(Number.isSafeInteger))
        return;
    if (BigInt(value.productMills) + BigInt(value.packagingMills) + BigInt(value.landedMills) !== BigInt(value.totalMills)) {
        context.addIssue({ code: "custom", message: "Returned cost components must equal their exact total." });
    }
});
export type SupplierReturnCostTotals = z.infer<typeof supplierReturnCostTotalsSchema>;
export const supplierReturnIntervalSchema = z.object({ start: nonnegative, quantity }).strict();
const intervals = z.array(supplierReturnIntervalSchema).min(1).max(10000).superRefine((rows, context) => {
    if (!rows.every(row => Number.isSafeInteger(row.start) && Number.isSafeInteger(row.quantity)))
        return;
    let end = BigInt(0);
    for (const row of [...rows].sort((left, right) => left.start - right.start)) {
        if (BigInt(row.start) < end || BigInt(row.start) + BigInt(row.quantity) > BigInt(Number.MAX_SAFE_INTEGER)) {
            context.addIssue({ code: "custom", message: "Returned quantity intervals overlap or exceed the supported range." });
            return;
        }
        end = BigInt(row.start) + BigInt(row.quantity);
    }
});
export const supplierReturnSourceProofSchema = z.object({
    contractVersion: z.literal(1),
    origin: z.object({
        inventoryLotId: id, receivingLineId: id, receivingOrderId: id, purchaseOrderLineId: id, purchaseOrderId: id,
        vendorId: id, productId: id, productVariantId: id, unitsPerVariant: quantity, receivedVariantQuantity: quantity,
        purchaseStartBasePiece: nonnegative, inboundShipmentLineId: id.nullable(), shipmentStartBasePiece: nonnegative.nullable(),
    }).strict(),
    transfers: z.array(z.object({
        contributionId: id, sourceLotId: id, outputLotId: id, sourceQuantity: quantity, outputQuantity: quantity,
        outputStartQuantity: nonnegative, allocationId: id, intervals,
    }).strict()).max(100),
}).strict().superRefine((value, context) => {
    if ((value.origin.inboundShipmentLineId === null) !== (value.origin.shipmentStartBasePiece === null)) {
        context.addIssue({ code: "custom", message: "Shipment identity and original quantity offset must be recorded together." });
    }
    const lots = new Set([value.origin.inventoryLotId]);
    const contributions = new Set<number>();
    let sourceLotId = value.origin.inventoryLotId;
    for (const transfer of value.transfers) {
        if (transfer.sourceLotId !== sourceLotId || lots.has(transfer.outputLotId) || contributions.has(transfer.contributionId)
            || transfer.sourceQuantity !== transfer.outputQuantity || transfer.outputStartQuantity !== 0) {
            context.addIssue({ code: "custom", message: "A supplier return requires one complete, noncyclic one-to-one transfer chain." });
        }
        if (Number.isSafeInteger(transfer.sourceQuantity) && transfer.intervals.every(row => Number.isSafeInteger(row.quantity))
            && transfer.intervals.reduce((total, row) => total + BigInt(row.quantity), BigInt(0)) !== BigInt(transfer.sourceQuantity)) {
            context.addIssue({ code: "custom", message: "Transfer quantity must equal its immutable cost intervals." });
        }
        lots.add(transfer.outputLotId);
        contributions.add(transfer.contributionId);
        sourceLotId = transfer.outputLotId;
    }
});
export type SupplierReturnSourceProof = z.infer<typeof supplierReturnSourceProofSchema>;
export const supplierReturnSelectionSchema = z.object({ inventoryLotId: inputId, quantity }).strict();
const selections = z.array(supplierReturnSelectionSchema).min(1).max(100).superRefine((rows, context) => {
    if (new Set(rows.map(row => row.inventoryLotId)).size !== rows.length) {
        context.addIssue({ code: "custom", message: "Select each physical lot only once per return." });
    }
});
export const supplierReturnPreviewInputSchema = z.object({ vendorId: inputId, lines: selections }).strict();
export type SupplierReturnPreviewInput = z.infer<typeof supplierReturnPreviewInputSchema>;
export const supplierReturnRecordInputSchema = supplierReturnPreviewInputSchema.extend({
    expectedSourceFingerprint: hash, returnCalendarDate: paymentCalendarDateSchema,
    evidenceReference: z.string().trim().min(1).max(1000), reason,
    supplierReference: z.string().trim().min(1).max(200).optional(),
});
export type SupplierReturnRecordInput = z.infer<typeof supplierReturnRecordInputSchema>;
export const supplierReturnStockPreviewLineSchema = z.object({
    inventoryLotId: id, inventoryLevelId: id, warehouseLocationId: id, warehouseId: id, productId: id, productVariantId: id,
    lotNumber: z.string(), sku: z.string().nullable(), locationCode: z.string(), unitLabel: z.string().min(1),
    quantity, availableQuantity: nonnegative, levelAvailableQuantity: nonnegative,
    unitsPerVariant: quantity, basePieces: id, sourceProof: supplierReturnSourceProofSchema,
    intervals, costs: supplierReturnCostTotalsSchema, costProvisional: z.boolean(),
}).strict().superRefine((value, context) => {
    const origin = value.sourceProof.origin;
    const lastLot = value.sourceProof.transfers.at(-1)?.outputLotId ?? origin.inventoryLotId;
    if (lastLot !== value.inventoryLotId || origin.productId !== value.productId || origin.productVariantId !== value.productVariantId
        || origin.unitsPerVariant !== value.unitsPerVariant || value.quantity > value.availableQuantity
        || value.quantity > value.levelAvailableQuantity) {
        context.addIssue({ code: "custom", message: "The selected return disagrees with its frozen source or available stock." });
    }
    if ([value.quantity, value.unitsPerVariant, value.basePieces].every(Number.isSafeInteger)
        && BigInt(value.quantity) * BigInt(value.unitsPerVariant) !== BigInt(value.basePieces)) {
        context.addIssue({ code: "custom", message: "Returned pieces must match the frozen lot-unit conversion." });
    }
    if (Number.isSafeInteger(value.quantity) && value.intervals.every(row => Number.isSafeInteger(row.quantity))
        && value.intervals.reduce((total, row) => total + BigInt(row.quantity), BigInt(0)) !== BigInt(value.quantity)) {
        context.addIssue({ code: "custom", message: "Returned cost intervals must equal the selected physical quantity." });
    }
});
export type SupplierReturnStockPreviewLine = z.infer<typeof supplierReturnStockPreviewLineSchema>;
export const supplierReturnStockPreviewSchema = z.object({
    vendorId: id, currency: z.literal("USD"), sourceFingerprint: hash,
    lines: z.array(supplierReturnStockPreviewLineSchema).min(1).max(100),
    totals: supplierReturnCostTotalsSchema, costProvisional: z.boolean(),
}).strict().superRefine((value, context) => {
    if (new Set(value.lines.map(line => line.inventoryLotId)).size !== value.lines.length
        || value.lines.some(line => line.sourceProof.origin.vendorId !== value.vendorId)
        || value.costProvisional !== value.lines.some(line => line.costProvisional)) {
        context.addIssue({ code: "custom", message: "Return source ownership or provisional cost evidence conflicts." });
    }
    for (const field of ["productMills", "packagingMills", "landedMills", "totalMills"] as const) {
        if (!Number.isSafeInteger(value.totals[field]) || !value.lines.every(line => Number.isSafeInteger(line.costs[field])))
            continue;
        if (value.lines.reduce((total, line) => total + BigInt(line.costs[field]), BigInt(0)) !== BigInt(value.totals[field])) {
            context.addIssue({ code: "custom", message: "Return preview totals do not equal the selected exact lot costs." });
        }
    }
    const levels = new Map<number, {
        selected: bigint;
        available: number;
    }>();
    for (const line of value.lines) {
        if (!Number.isSafeInteger(line.quantity) || !Number.isSafeInteger(line.levelAvailableQuantity))
            continue;
        const prior = levels.get(line.inventoryLevelId);
        if (prior && prior.available !== line.levelAvailableQuantity) {
            context.addIssue({ code: "custom", message: "Selected lots disagree about their shared location availability." });
        }
        const selected = (prior?.selected ?? BigInt(0)) + BigInt(line.quantity);
        if (selected > BigInt(line.levelAvailableQuantity)) {
            context.addIssue({ code: "custom", message: "The selected lots exceed their shared location availability." });
        }
        levels.set(line.inventoryLevelId, { selected, available: line.levelAvailableQuantity });
    }
});
export type SupplierReturnStockPreview = z.infer<typeof supplierReturnStockPreviewSchema>;
export const supplierReturnPreviewSchema = supplierReturnStockPreviewSchema;
export const supplierReturnOptionsQuerySchema = z.object({
    vendorId: queryId, purchaseOrderId: queryId.optional(),
    receivingOrderId: queryId.optional(),
    afterLotId: queryId.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export type SupplierReturnOptionsQuery = z.infer<typeof supplierReturnOptionsQuerySchema>;
export const supplierReturnStockOptionsSchema = z.object({
    items: z.array(z.object({
        inventoryLotId: id, inventoryLevelId: id.nullable(), warehouseLocationId: id, warehouseId: id.nullable(), productId: id, productVariantId: id,
        lotNumber: z.string(), sku: z.string().nullable(), locationCode: z.string(), unitLabel: z.string().min(1),
        purchaseOrderId: id, receivingOrderId: id, purchaseOrderLineId: id,
        availableQuantity: nonnegative, unitsPerVariant: quantity.nullable(), eligible: z.boolean(),
        issues: z.array(supplierReturnIssueSchema),
    }).strict().superRefine((row, context) => {
        if (row.eligible && (row.inventoryLevelId === null || row.warehouseId === null || row.unitsPerVariant === null || row.availableQuantity === 0 || row.issues.length > 0)) {
            context.addIssue({ code: "custom", message: "An eligible supplier-return lot needs verified conversion and available stock." });
        }
    })).max(100), nextAfterLotId: id.nullable(),
}).strict();
export type SupplierReturnStockOptions = z.infer<typeof supplierReturnStockOptionsSchema>;
export const supplierReturnOptionsSchema = supplierReturnStockOptionsSchema;
export const supplierReturnStockReceiptLineSchema = z.object({
    returnLineId: id, returnAllocationId: id, inventoryTransactionId: id, inventoryLotId: id, productVariantId: id,
    warehouseLocationId: id, quantity, costQuantityAllocationId: id,
    initialCostEntryIds: z.object({ product: id, packaging: id, landed: id }).strict(),
}).strict();
export const supplierReturnStockReceiptSchema = z.object({
    returnId: id, commandKey: z.string().min(1).max(200), sourceFingerprint: hash, actorId: z.string().min(1),
    occurredAt: timestamp, lines: z.array(supplierReturnStockReceiptLineSchema).min(1).max(100), replayed: z.boolean(),
}).strict().superRefine((value, context) => {
    for (const key of ["returnLineId", "returnAllocationId", "inventoryTransactionId", "inventoryLotId", "costQuantityAllocationId"] as const) {
        if (new Set(value.lines.map(line => line[key])).size !== value.lines.length) {
            context.addIssue({ code: "custom", message: `Recorded return repeats a ${key}.` });
        }
    }
    const entries = value.lines.flatMap(line => Object.values(line.initialCostEntryIds));
    if (new Set(entries).size !== entries.length)
        context.addIssue({ code: "custom", message: "Initial return cost entries must be distinct." });
});
export type SupplierReturnStockReceipt = z.infer<typeof supplierReturnStockReceiptSchema>;
export const supplierReturnCostAdjustmentSchema = z.object({
    entryId: id, returnId: id, returnLineId: id, returnAllocationId: id, inventoryLotId: id, costQuantityAllocationId: id,
    quantity, component: supplierReturnComponentSchema, beforeMills: nonnegative, afterMills: nonnegative,
    deltaMills: z.number().int().safe(), postingKey: z.string().min(1).max(500),
}).strict().superRefine((value, context) => {
    if (![value.beforeMills, value.afterMills, value.deltaMills].every(Number.isSafeInteger))
        return;
    if (BigInt(value.beforeMills) + BigInt(value.deltaMills) !== BigInt(value.afterMills)) {
        context.addIssue({ code: "custom", message: "Return value adjustment must conserve its exact before and after amounts." });
    }
});
export type SupplierReturnCostAdjustment = z.infer<typeof supplierReturnCostAdjustmentSchema>;
export const supplierReturnCostEntrySchema = z.object({
    id, returnAllocationId: id, component: supplierReturnComponentSchema, previousMills: nonnegative, nextMills: nonnegative,
    deltaMills: z.number().int().safe(), postingKey: z.string().min(1).max(500), reason: z.string().min(1),
    sourceRevisionId: id.nullable(), applicationId: id.nullable(), recordedBy: z.string().min(1), recordedAt: timestamp,
}).strict().superRefine((value, context) => {
    if (![value.previousMills, value.nextMills, value.deltaMills].every(Number.isSafeInteger))
        return;
    if (BigInt(value.previousMills) + BigInt(value.deltaMills) !== BigInt(value.nextMills)) {
        context.addIssue({ code: "custom", message: "Return cost history does not conserve its exact amount." });
    }
});
export type SupplierReturnCostEntry = z.infer<typeof supplierReturnCostEntrySchema>;
export const supplierReturnInventoryEvidenceSchema = z.object({
    receipt: supplierReturnStockReceiptSchema,
    lines: z.array(z.object({
        returnLineId: id, currentCosts: supplierReturnCostTotalsSchema,
        costEntries: z.array(supplierReturnCostEntrySchema).min(3).max(10000),
    }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
    if (value.lines.length !== value.receipt.lines.length || new Set(value.lines.map(line => line.returnLineId)).size !== value.lines.length) {
        context.addIssue({ code: "custom", message: "Returned value evidence must identify every immutable stock receipt line once." });
    }
    for (const line of value.lines) {
        const receipt = value.receipt.lines.find(row => row.returnLineId === line.returnLineId);
        if (!receipt || line.costEntries.some(entry => entry.returnAllocationId !== receipt.returnAllocationId)) {
            context.addIssue({ code: "custom", message: "Returned value evidence identifies an unrelated physical allocation." });
        }
    }
});
export type SupplierReturnInventoryEvidence = z.infer<typeof supplierReturnInventoryEvidenceSchema>;
export const supplierReturnCreditStateSchema = z.enum(["unmatched", "partially_matched", "matched", "review_required"]);
export const supplierReturnCreditLinkSchema = z.object({
    creditId: id, creditLineId: id, sourceInvoiceId: id, supplierReference: z.string(),
    status: z.enum(["approved", "voided"]), entitlementId: id, quantity,
    component: z.enum(["product", "packaging", "landed", "unassigned"]), amountCents: nonnegative.positive(),
}).strict();
export const supplierReturnInvoiceChoiceSchema = z.object({
    sourceInvoiceId: id, invoiceLineId: id, invoiceNumber: z.string(),
    components: z.array(z.enum(["product", "packaging", "landed", "unassigned"])),
}).strict();
export const supplierReturnDetailSchema = z.object({
    id, vendorId: id, vendorName: z.string(), status: z.literal("recorded"), supplierReference: z.string().nullable(),
    returnCalendarDate: paymentCalendarDateSchema, evidenceReference: z.string().min(1), reason: z.string().min(3),
    sourceFingerprint: hash, recordedBy: z.string().min(1), recordedAt: timestamp,
    inventoryReceipt: supplierReturnStockReceiptSchema,
    lines: z.array(z.object({
        id, source: supplierReturnStockPreviewLineSchema, currentCosts: supplierReturnCostTotalsSchema,
        costEntries: z.array(supplierReturnCostEntrySchema).min(3).max(10000),
        creditState: supplierReturnCreditStateSchema, creditIssues: z.array(supplierReturnIssueSchema),
        creditLinks: z.array(supplierReturnCreditLinkSchema).optional(), sourceInvoices: z.array(supplierReturnInvoiceChoiceSchema).optional(),
    }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
    const receipt = value.inventoryReceipt;
    if (receipt.returnId !== value.id || receipt.actorId !== value.recordedBy || receipt.sourceFingerprint !== value.sourceFingerprint
        || receipt.occurredAt !== value.recordedAt || receipt.lines.length !== value.lines.length
        || new Set(value.lines.map(line => line.id)).size !== value.lines.length) {
        context.addIssue({ code: "custom", message: "Supplier return header and immutable stock receipt disagree." });
    }
    for (const line of value.lines) {
        const recorded = receipt.lines.find(row => row.returnLineId === line.id);
        if (!recorded || line.source.sourceProof.origin.vendorId !== value.vendorId
            || recorded.inventoryLotId !== line.source.inventoryLotId || recorded.productVariantId !== line.source.productVariantId
            || recorded.quantity !== line.source.quantity || recorded.warehouseLocationId !== line.source.warehouseLocationId
            || line.costEntries.some(entry => entry.returnAllocationId !== recorded.returnAllocationId)) {
            context.addIssue({ code: "custom", message: "Supplier return line disagrees with its recorded stock and value identities." });
        }
    }
});
export type SupplierReturnDetail = z.infer<typeof supplierReturnDetailSchema>;
export const supplierReturnListQuerySchema = z.object({
    vendorId: queryId.optional(), purchaseOrderId: queryId.optional(),
    receivingOrderId: queryId.optional(),
    afterId: queryId.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();
export const supplierReturnListSchema = z.object({
    items: z.array(z.object({
        id, vendorId: id, vendorName: z.string(), status: z.literal("recorded"), supplierReference: z.string().nullable(),
        returnCalendarDate: paymentCalendarDateSchema, evidenceReference: z.string(), recordedBy: z.string(), recordedAt: timestamp,
        returnedBasePieces: id, initialCosts: supplierReturnCostTotalsSchema, currentCosts: supplierReturnCostTotalsSchema,
        creditState: supplierReturnCreditStateSchema,
    }).strict()).max(100), nextAfterId: id.nullable(),
}).strict();
export const supplierReturnCommandResultSchema = z.object({
    command: z.literal("record"), actorId: z.string().min(1), idempotencyKey: z.string().min(1).max(200),
    request: supplierReturnRecordInputSchema, returnId: id, return: supplierReturnDetailSchema,
}).strict().superRefine((value, context) => {
    if (value.returnId !== value.return.id || value.actorId !== value.return.recordedBy
        || value.idempotencyKey !== value.return.inventoryReceipt.commandKey) {
        context.addIssue({ code: "custom", message: "Recorded supplier return response identity conflicts." });
    }
});
export type SupplierReturnCommandResult = z.infer<typeof supplierReturnCommandResultSchema>;
