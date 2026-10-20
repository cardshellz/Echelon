import { sql } from "drizzle-orm";
import { supplierCreditSourceEvidenceSchema, supplierCreditDispositionMatches } from "./domain/supplier-credit-source";
import { projectReturnCreditReview } from "./domain/supplier-return-credit-review";
import { supplierReturnCreditReviewEntrySchema } from "@shared/procurement/supplier-return-credit";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { acceptedReturnCreditSourceSchema, type AcceptedReturnCreditSource } from "@shared/procurement/supplier-return-credit";
import { supplierReturnCreditLinkSchema, supplierReturnInvoiceChoiceSchema, supplierReturnStockPreviewLineSchema, supplierReturnIntervalSchema, type SupplierReturnCostTotals } from "@shared/procurement/supplier-return";
import { supplierCreditSourceLineInputSchema, type SourceLineInput } from "@shared/procurement/supplier-credit";
import { readSupplierReturnInventoryEvidenceBatch } from "../inventory/application/supplier-return-stock";
import { lotCostsForIntervals } from "../inventory/domain/lot-cost";
import { subtractCostQuantityIntervals, sliceCostQuantityIntervals } from "../inventory/domain/cost-quantity-intervals";
import { costInteger, costFingerprint, CostEvidenceError, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
const idsSchema = z.array(z.number().int().positive().safe()).max(1000);
const fields = { product: "productMills", packaging: "packagingMills", landed: "landedMills" } as const;
const intervalSchema = z.array(supplierReturnIntervalSchema).min(1).max(10000);
const issue = (code: string, message: string) => ({ code, message });
function costsFor(row: Record<string, unknown>, intervals: Array<{
    start: number;
    quantity: number;
}>): SupplierReturnCostTotals {
    const costs = lotCostsForIntervals(z.record(z.string(), z.unknown()).parse(row.lot), intervals);
    return { productMills: costInteger(costs.poMills.toString(), "return.productMills"),
        packagingMills: costInteger(costs.packagingMills.toString(), "return.packagingMills"),
        landedMills: costInteger(costs.landedMills.toString(), "return.landedMills"), totalMills: costInteger(costs.totalMills.toString(), "return.totalMills") };
}
/** One bounded snapshot serves options, detail and approval. The inventory
 * owner proves immutable stock movement and chained returned value first. */
export async function loadReturnCreditEvidence(tx: CostEvidenceTransaction, rawIds: readonly number[]) {
    const ids = idsSchema.parse([...new Set(rawIds)]);
    if (!ids.length)
        return { rows: [], entitlements: [], links: [], choices: [], reviews: [], values: new Map<number, {
                currentCosts: SupplierReturnCostTotals;
                costEntries: Array<{
                    id: number;
                }>;
            }>() };
    const rows = (await tx.execute(sql `SELECT line.*,header.vendor_id,header.evidence_reference,header.source_fingerprint,
      header.return_calendar_date,to_jsonb(lot) AS lot
    FROM procurement.supplier_return_lines line JOIN procurement.supplier_returns header ON header.id=line.supplier_return_id
    JOIN inventory.inventory_lots lot ON lot.id=line.inventory_lot_id WHERE line.id=ANY(${sql.param(ids)}::int[]) ORDER BY line.id`)).rows;
    if (rows.length !== ids.length)
        throw new CostEvidenceError("SUPPLIER_RETURN_SOURCE_MISSING", "A selected immutable supplier return line is missing.");
    const returnIds = [...new Set(rows.map(row => costInteger(row.supplier_return_id, "returnId", 1)))];
    const values = new Map<number, {
        currentCosts: SupplierReturnCostTotals;
        costEntries: Array<{
            id: number;
        }>;
    }>();
    for (let index = 0; index < returnIds.length; index += 100) {
        const batch = await readSupplierReturnInventoryEvidenceBatch(tx, returnIds.slice(index, index + 100));
        for (const document of batch.values())
            for (const line of document.lines)
                values.set(line.returnLineId, line);
    }
    for (const row of rows) {
        const source = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
        const current = values.get(Number(row.id));
        if (!current || canonicalJson(current.currentCosts) !== canonicalJson(costsFor(row, source.intervals))) {
            throw new CostEvidenceError("SUPPLIER_RETURN_VALUE_REVIEW", "Current returned value does not match its immutable component history.");
        }
    }
    const entitlements = (await tx.execute(sql `SELECT * FROM procurement.supplier_return_credit_entitlements
    WHERE supplier_return_line_id=ANY(${sql.param(ids)}::int[]) ORDER BY id`)).rows;
    const links = (await tx.execute(sql `SELECT link.*,entitlement.supplier_return_line_id,entitlement.quantity,
      credit.id AS credit_id,credit.source_invoice_id,credit.supplier_reference,credit.status,credit.vendor_id,
      line.disposition,line.invoice_line_id,line.amount_cents AS line_amount_cents,line.source_evidence
    FROM procurement.supplier_return_credit_links link
    JOIN procurement.supplier_return_credit_entitlements entitlement ON entitlement.id=link.entitlement_id
    JOIN procurement.supplier_credit_lines line ON line.id=link.supplier_credit_line_id
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    WHERE entitlement.supplier_return_line_id=ANY(${sql.param(ids)}::int[]) ORDER BY link.id LIMIT 10001`)).rows;
    if (links.length > 10000)
        throw new CostEvidenceError("SUPPLIER_RETURN_CREDIT_LIMIT", "Return credit history exceeds its bounded complete read.");
    const choices = (await tx.execute(sql `SELECT returned.id AS return_line_id,invoice.id AS source_invoice_id,
      invoice.invoice_number,line.id AS invoice_line_id,line.purchase_order_line_id,line.freight_cost_id
    FROM procurement.supplier_return_lines returned JOIN procurement.supplier_returns header ON header.id=returned.supplier_return_id
    JOIN procurement.vendor_invoices invoice ON invoice.vendor_id=header.vendor_id AND invoice.currency='USD' AND invoice.status IN ('approved','partially_paid','paid')
    JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
    WHERE returned.id=ANY(${sql.param(ids)}::int[]) AND (
      line.purchase_order_line_id=returned.purchase_order_line_id AND line.freight_cost_id IS NULL
      OR line.purchase_order_line_id IS NULL AND line.freight_cost_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM procurement.inbound_freight_allocations allocation
        WHERE allocation.shipment_cost_id=line.freight_cost_id
        AND allocation.inbound_shipment_line_id=(returned.source_snapshot->'sourceProof'->'origin'->>'inboundShipmentLineId')::int))
    ORDER BY returned.id,invoice.id,line.id LIMIT 10001`)).rows;
    if (choices.length > 10000)
        throw new CostEvidenceError("SUPPLIER_RETURN_INVOICE_LIMIT", "Return source invoice choices exceed their bounded complete read.");
    const reviews = (await tx.execute(sql `SELECT review.* FROM procurement.supplier_return_credit_reviews review
    JOIN procurement.supplier_return_credit_entitlements entitlement ON entitlement.id=review.entitlement_id
    WHERE entitlement.supplier_return_line_id=ANY(${sql.param(ids)}::int[]) ORDER BY review.id LIMIT 10001`)).rows;
    if (reviews.length > 10000)
        throw new CostEvidenceError("SUPPLIER_RETURN_REVIEW_LIMIT", "Return difference review history exceeds its bounded complete read.");
    // Validate retained relationships before either a display or a new review can
    // use them. Database constraints protect new rows; imported/corrupt evidence
    // must still fail closed at this read boundary.
    for (const row of rows) {
        const source = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
        const owned = entitlements.filter(item => Number(item.supplier_return_line_id) === Number(row.id));
        const intervals = owned.flatMap(item => intervalSchema.parse(item.intervals));
        subtractCostQuantityIntervals(source.intervals, intervals, costInteger(row.lot.cost_basis_qty, "costBasis", 1));
        for (const entitlement of owned) {
            if (intervalSchema.parse(entitlement.intervals).reduce((sum, part) => sum + part.quantity, 0) !== costInteger(entitlement.quantity, "entitlementQuantity", 1)) {
                throw new CostEvidenceError("RETURN_CREDIT_ENTITLEMENT_REVIEW", "Retained returned quantity and intervals disagree.");
            }
        }
    }
    for (const link of links) {
        retainedReturnCreditLink(link);
        const original = supplierCreditSourceEvidenceSchema.parse(link.source_evidence);
        const accepted = acceptedReturnCreditSourceSchema.parse(original.acceptedReturnSource);
        const row = rows.find(item => Number(item.id) === Number(link.supplier_return_line_id));
        const entitlement = entitlements.find(item => Number(item.id) === Number(link.entitlement_id));
        if (!row || !entitlement || Number(link.vendor_id) !== Number(row.vendor_id)
            || costInteger(link.amount_cents, "creditAmount", 1) !== costInteger(link.line_amount_cents, "creditLineAmount", 1)
            || original.invoiceLineId !== Number(link.invoice_line_id) || original.invoiceId !== Number(link.source_invoice_id)
            || !supplierCreditDispositionMatches({ id: link.supplier_credit_line_id, supplier_credit_id: link.credit_id,
                invoice_line_id: link.invoice_line_id, amount_cents: link.amount_cents, disposition: link.disposition,
                source_evidence: link.source_evidence, status: link.status }, original)
            || accepted.returnLineId !== Number(row.id) || accepted.returnId !== Number(row.supplier_return_id)
            || accepted.returnAllocationId !== Number(entitlement.return_allocation_id)
            || accepted.sourceFingerprint !== row.source_fingerprint || accepted.evidenceReference !== row.evidence_reference
            || accepted.quantity !== Number(entitlement.quantity)
            || accepted.entitlementId !== null && accepted.entitlementId !== Number(entitlement.id)
            || canonicalJson(accepted.intervals) !== canonicalJson(entitlement.intervals)
            || accepted.reviewedEntryIds.some(id => !values.get(Number(row.id))!.costEntries.some(entry => entry.id === id))) {
            throw new CostEvidenceError("RETURN_CREDIT_LINK_REVIEW", "Retained supplier credit evidence does not match its immutable return entitlement.");
        }
    }
    return { rows, entitlements, links, choices, reviews, values };
}
export function retainedReturnCreditLink(raw: Record<string, unknown>) {
    return supplierReturnCreditLinkSchema.parse({ creditId: costInteger(raw.credit_id, "creditId", 1),
        creditLineId: costInteger(raw.supplier_credit_line_id, "creditLineId", 1), sourceInvoiceId: costInteger(raw.source_invoice_id, "invoiceId", 1),
        supplierReference: raw.supplier_reference, status: raw.status, entitlementId: costInteger(raw.entitlement_id, "entitlementId", 1),
        quantity: costInteger(raw.quantity, "quantity", 1), component: raw.component, amountCents: costInteger(raw.amount_cents, "amountCents", 1) });
}
function invoiceChoice(raw: Record<string, unknown>) {
    return supplierReturnInvoiceChoiceSchema.parse({ sourceInvoiceId: costInteger(raw.source_invoice_id, "invoiceId", 1),
        invoiceLineId: costInteger(raw.invoice_line_id, "invoiceLineId", 1), invoiceNumber: raw.invoice_number,
        components: raw.freight_cost_id === null ? ["product", "packaging", "unassigned"] : ["landed"] });
}
export async function readSupplierReturnCreditStates(tx: CostEvidenceTransaction, returnLineIds: readonly number[]) {
    const evidence = await loadReturnCreditEvidence(tx, returnLineIds);
    const result = new Map<number, {
        creditState: "unmatched" | "partially_matched" | "matched" | "review_required";
        creditIssues: Array<{
            code: string;
            message: string;
        }>;
        creditLinks: z.infer<typeof supplierReturnCreditLinkSchema>[];
        sourceInvoices: z.infer<typeof supplierReturnInvoiceChoiceSchema>[];
    }>();
    for (const row of evidence.rows) {
        const id = Number(row.id), source = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
        const entitlements = evidence.entitlements.filter(item => Number(item.supplier_return_line_id) === id);
        const links = evidence.links.filter(item => Number(item.supplier_return_line_id) === id);
        const creditIssues = [];
        let settledQuantity = 0, allMatched = true;
        const used = entitlements.flatMap(item => intervalSchema.parse(item.intervals));
        subtractCostQuantityIntervals(source.intervals, used, costInteger(row.lot.cost_basis_qty, "costBasis", 1));
        for (const entitlement of entitlements) {
            const projection = projectReturnCreditEntitlement(evidence, Number(entitlement.id));
            const active = projection.review.creditLinks.filter(link => link.status === "approved");
            if (!active.length) {
                allMatched = false;
                continue;
            }
            settledQuantity += costInteger(entitlement.quantity, "quantity", 1);
            const difference = projection.review.differences;
            if (projection.review.latestReview && !projection.review.reviewCurrent) {
                creditIssues.push(issue("RETURN_CREDIT_REVIEW_STALE", "Returned value or active supplier credits changed after the last review. Review current evidence again."));
            }
            if (difference.unassignedCreditCents > 0)
                creditIssues.push(issue("RETURN_CREDIT_COMPONENT_REQUIRED", "A supplier credit amount still requires an explicit component allocation."));
            for (const component of Object.keys(fields) as Array<keyof typeof fields>) {
                if (difference[fields[component]] !== 0) {
                    allMatched = false;
                    if (active.some(link => link.component === component || link.component === "unassigned")) {
                        creditIssues.push(issue("RETURN_CREDIT_DIFFERENCE", `The ${component} supplier credit differs from current returned value. Review the difference explicitly.`));
                    }
                }
            }
        }
        for (const link of links) {
            const disposition = supplierCreditSourceLineInputSchema.safeParse({ invoiceLineId: 1, amountCents: costInteger(link.line_amount_cents, "lineAmount", 1), disposition: link.disposition });
            const sourceEvidence = acceptedReturnCreditSourceSchema.safeParse(link.source_evidence?.acceptedReturnSource);
            const entitlement = entitlements.find(item => Number(item.id) === Number(link.entitlement_id));
            if (!disposition.success || disposition.data.disposition.kind !== "accepted_stock_return" || !sourceEvidence.success || !entitlement
                || Number(link.vendor_id) !== Number(row.vendor_id) || costInteger(link.amount_cents, "amount", 1) !== costInteger(link.line_amount_cents, "lineAmount", 1)
                || sourceEvidence.data.returnLineId !== id || sourceEvidence.data.quantity !== Number(entitlement.quantity)
                || canonicalJson(sourceEvidence.data.intervals) !== canonicalJson(entitlement.intervals)) {
                creditIssues.push(issue("RETURN_CREDIT_LINK_REVIEW", "Retained supplier credit linkage conflicts with its immutable physical entitlement."));
            }
        }
        const activeCount = links.filter(link => link.status === "approved").length;
        result.set(id, { creditState: creditIssues.length ? "review_required" : !activeCount ? "unmatched"
                : allMatched && settledQuantity === source.quantity ? "matched" : "partially_matched", creditIssues,
            creditLinks: links.map(retainedReturnCreditLink), sourceInvoices: evidence.choices.filter(item => Number(item.return_line_id) === id).map(invoiceChoice) });
    }
    return result;
}
export async function readAcceptedReturnCreditOptions(tx: CostEvidenceTransaction, invoice: Record<string, unknown>) {
    const rows = (await tx.execute(sql `SELECT returned.id FROM procurement.supplier_return_lines returned
    JOIN procurement.supplier_returns header ON header.id=returned.supplier_return_id
    WHERE header.vendor_id=${costInteger(invoice.vendor_id, "vendorId", 1)} AND (
      returned.purchase_order_line_id=${invoice.purchase_order_line_id ?? null}
      OR EXISTS(SELECT 1 FROM procurement.inbound_freight_allocations allocation WHERE allocation.shipment_cost_id=${invoice.freight_cost_id ?? null}
        AND allocation.inbound_shipment_line_id=(returned.source_snapshot->'sourceProof'->'origin'->>'inboundShipmentLineId')::int))
    ORDER BY returned.id LIMIT 1001`)).rows;
    if (rows.length > 1000)
        throw new CostEvidenceError("SUPPLIER_RETURN_OPTION_LIMIT", "Return source options exceed their bounded complete read.");
    const evidence = await loadReturnCreditEvidence(tx, rows.map(row => Number(row.id)));
    return evidence.rows.flatMap(row => {
        const choice = evidence.choices.find(item => Number(item.return_line_id) === Number(row.id) && Number(item.invoice_line_id) === Number(invoice.id));
        if (!choice)
            return [];
        const source = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
        const entitlements = evidence.entitlements.filter(item => Number(item.supplier_return_line_id) === Number(row.id));
        const quantityUsed = entitlements.reduce((sum, item) => sum + costInteger(item.quantity, "entitlementQuantity", 1), 0);
        // Goods invoice quantities are base pieces; return quantities are frozen
        // lot units. Options must not advertise a selection the command rejects.
        const invoiceQuantityLimit = invoice.purchase_order_line_id == null ? source.quantity
            : Number(BigInt(costInteger(invoice.qty_invoiced, "invoiceQuantity", 1)) / BigInt(source.unitsPerVariant));
        return [{ supplierReturnId: Number(row.supplier_return_id), supplierReturnLineId: Number(row.id),
                quantityAvailable: Math.min(source.quantity - quantityUsed, invoiceQuantityLimit), unitsPerVariant: source.unitsPerVariant,
                evidenceReference: String(row.evidence_reference), label: `${source.lotNumber} · ${row.return_calendar_date}`,
                components: invoiceChoice(choice).components, entitlements: entitlements.filter(item => Number(item.quantity) <= invoiceQuantityLimit).map(item => ({ id: Number(item.id), quantity: Number(item.quantity) })) }];
    });
}
export async function reviewAcceptedReturnCreditSource(tx: CostEvidenceTransaction, input: {
    invoice: Record<string, unknown>;
    line: SourceLineInput;
    creditId?: number;
}): Promise<AcceptedReturnCreditSource> {
    const disposition = input.line.disposition;
    if (disposition.kind !== "accepted_stock_return")
        throw new CostEvidenceError("RETURN_CREDIT_KIND_REQUIRED", "Choose an accepted-stock return source.");
    const evidence = await loadReturnCreditEvidence(tx, [disposition.supplierReturnLineId]);
    const row = evidence.rows[0], source = supplierReturnStockPreviewLineSchema.parse(row.source_snapshot);
    const choice = evidence.choices.find(item => Number(item.invoice_line_id) === Number(input.invoice.id));
    if (!choice || Number(row.vendor_id) !== Number(input.invoice.vendor_id) || row.evidence_reference !== disposition.evidenceReference
        || !invoiceChoice(choice).components.includes(disposition.component)) {
        throw new CostEvidenceError("RETURN_CREDIT_SOURCE_MISMATCH", "Choose the original approved invoice, recorded collection evidence and supported component for this return.");
    }
    if (input.invoice.purchase_order_line_id != null
        && BigInt(disposition.quantity) * BigInt(source.unitsPerVariant) > BigInt(costInteger(input.invoice.qty_invoiced, "invoiceQuantity", 1))) {
        throw new CostEvidenceError("RETURN_CREDIT_INVOICE_QUANTITY", "The selected returned quantity exceeds the original goods invoice quantity. Choose its documented source.");
    }
    const ownedLink = input.creditId === undefined ? undefined : evidence.links.find(link => Number(link.credit_id) === input.creditId
        && Number(link.invoice_line_id) === input.line.invoiceLineId && link.component === disposition.component
        && link.disposition?.entitlementId === disposition.entitlementId);
    if (ownedLink)
        return acceptedReturnCreditSourceSchema.parse(ownedLink.source_evidence.acceptedReturnSource);
    const entitlements = evidence.entitlements.filter(item => Number(item.supplier_return_line_id) === disposition.supplierReturnLineId);
    const existing = disposition.entitlementId === undefined ? undefined : entitlements.find(item => Number(item.id) === disposition.entitlementId);
    if (disposition.entitlementId !== undefined && (!existing || Number(existing.quantity) !== disposition.quantity)) {
        throw new CostEvidenceError("RETURN_CREDIT_ENTITLEMENT_MISMATCH", "An additional credit must name its original complete returned-quantity entitlement.");
    }
    const basis = costInteger(row.lot.cost_basis_qty, "costBasis", 1);
    const free = subtractCostQuantityIntervals(source.intervals, entitlements.flatMap(item => intervalSchema.parse(item.intervals)), basis);
    const available = free.reduce((sum, item) => sum + item.quantity, 0);
    if (!existing && disposition.quantity > available)
        throw new CostEvidenceError("RETURN_CREDIT_QUANTITY_EXCEEDED", "The reviewed free returned quantity changed; choose an existing entitlement for a top-up or reload.");
    const intervals = existing ? intervalSchema.parse(existing.intervals) : sliceCostQuantityIntervals(free, 0, disposition.quantity);
    const current = evidence.values.get(Number(row.id))!;
    return acceptedReturnCreditSourceSchema.parse({ contractVersion: 1, returnId: Number(row.supplier_return_id), returnLineId: Number(row.id),
        returnAllocationId: existing ? Number(existing.return_allocation_id) : costInteger((await tx.execute(sql `SELECT id FROM inventory.supplier_return_allocations WHERE supplier_return_line_id=${Number(row.id)}`)).rows[0]?.id, "returnAllocationId", 1),
        sourceFingerprint: row.source_fingerprint, entitlementId: disposition.entitlementId ?? null,
        quantity: disposition.quantity, unitsPerVariant: source.unitsPerVariant, intervals,
        evidenceReference: row.evidence_reference, reviewedCosts: costsFor(row, intervals), reviewedEntryIds: current.costEntries.map(entry => entry.id) });
}
/** Called only after the approved document has been locked in the shared graph.
 * A second component on this document reuses its explicitly reviewed same slice;
 * another document must name an existing entitlement or reserve its own free slice. */
export async function recordAcceptedReturnCreditLinks(tx: CostEvidenceTransaction, input: {
    creditId: number;
    actorId: string;
    at: Date;
}) {
    const rows = (await tx.execute(sql `SELECT id,amount_cents,disposition,source_evidence FROM procurement.supplier_credit_lines
    WHERE supplier_credit_id=${input.creditId} AND disposition->>'kind'='accepted_stock_return' ORDER BY id`)).rows;
    const created = new Map<string, number>();
    for (const row of rows) {
        const source = acceptedReturnCreditSourceSchema.parse(row.source_evidence.acceptedReturnSource);
        const existing = (await tx.execute(sql `SELECT id FROM procurement.supplier_return_credit_links WHERE supplier_credit_line_id=${Number(row.id)}`)).rows[0];
        if (existing)
            continue;
        const group = canonicalJson({ returnLineId: source.returnLineId, intervals: source.intervals });
        let entitlementId = source.entitlementId ?? created.get(group);
        if (!entitlementId) {
            const inserted = (await tx.execute(sql `INSERT INTO procurement.supplier_return_credit_entitlements
        (supplier_return_line_id,return_allocation_id,quantity,intervals,source_evidence,recorded_by,recorded_at)
        VALUES (${source.returnLineId},${source.returnAllocationId},${source.quantity},${canonicalJson(source.intervals)}::jsonb,
          ${canonicalJson({ contractVersion: 1, creditId: input.creditId, source })}::jsonb,${input.actorId},${input.at}) RETURNING id`)).rows[0];
            entitlementId = costInteger(inserted.id, "entitlementId", 1);
            created.set(group, entitlementId);
        }
        await tx.execute(sql `INSERT INTO procurement.supplier_return_credit_links
      (supplier_credit_line_id,entitlement_id,component,amount_cents,recorded_by,recorded_at)
      VALUES (${Number(row.id)},${entitlementId},${row.disposition.component},${costInteger(row.amount_cents, "amountCents", 1)},${input.actorId},${input.at})`);
    }
}
export async function readAcceptedReturnCreditCostStatus(tx: CostEvidenceTransaction, creditLineId: number) {
    const raw = (await tx.execute(sql `SELECT line.disposition,credit.status,link.entitlement_id,entitlement.intervals,
      returned.*,to_jsonb(lot) AS lot FROM procurement.supplier_credit_lines line
    JOIN procurement.supplier_credits credit ON credit.id=line.supplier_credit_id
    LEFT JOIN procurement.supplier_return_credit_links link ON link.supplier_credit_line_id=line.id
    LEFT JOIN procurement.supplier_return_credit_entitlements entitlement ON entitlement.id=link.entitlement_id
    LEFT JOIN procurement.supplier_return_lines returned ON returned.id=entitlement.supplier_return_line_id
    LEFT JOIN inventory.inventory_lots lot ON lot.id=returned.inventory_lot_id WHERE line.id=${creditLineId}`)).rows[0];
    if (!raw || raw.id == null)
        return { costState: "review_required" as const, costIssues: [issue("RETURN_CREDIT_LINK_REQUIRED", "The approved credit has no verified returned-quantity entitlement.")] };
    const evidence = await loadReturnCreditEvidence(tx, [Number(raw.id)]);
    const projection = projectReturnCreditEntitlement(evidence, Number(raw.entitlement_id));
    if (raw.status === "voided")
        return { costState: "posted" as const, costIssues: [] };
    const component = raw.disposition.component as keyof typeof fields | "unassigned";
    const issues = [];
    if (projection.review.latestReview && !projection.review.reviewCurrent) {
        issues.push(issue("RETURN_CREDIT_REVIEW_STALE", "Returned value or supplier credits changed after the difference review."));
    }
    const difference = projection.review.differences;
    if (component === "unassigned" && difference.unassignedCreditCents > 0) {
        issues.push(issue("RETURN_CREDIT_COMPONENT_REQUIRED", "Allocate the supplier credit to explicit returned-value components before marking cost review complete."));
    }
    else if (component === "unassigned" ? difference.productMills !== 0 || difference.packagingMills !== 0
        : difference[fields[component]] !== 0) {
        issues.push(issue("RETURN_CREDIT_DIFFERENCE", "The supplier credit differs from current returned component value. An explicit difference resolution is still required."));
    }
    return { costState: issues.length ? "review_required" as const : "posted" as const, costIssues: issues };
}
export function projectReturnCreditEntitlement(evidence: Awaited<ReturnType<typeof loadReturnCreditEvidence>>, entitlementId: number) {
    const entitlement = evidence.entitlements.find(item => Number(item.id) === entitlementId);
    if (!entitlement)
        throw new CostEvidenceError("RETURN_CREDIT_ENTITLEMENT_MISSING", "Returned quantity entitlement is missing.");
    const row = evidence.rows.find(item => Number(item.id) === Number(entitlement.supplier_return_line_id));
    if (!row)
        throw new CostEvidenceError("RETURN_CREDIT_SOURCE_MISSING", "The entitlement has no immutable supplier return source.");
    const links = evidence.links.filter(item => Number(item.entitlement_id) === entitlementId).map(item => ({
        ...retainedReturnCreditLink(item), id: costInteger(item.id, "creditLinkId", 1),
        attributionComponents: item.component === "unassigned" ? ["product" as const, "packaging" as const] : [],
    }));
    const history = evidence.reviews.filter(item => Number(item.entitlement_id) === entitlementId).map(item => {
        if (costFingerprint(item.source_evidence) !== item.source_fingerprint)
            throw new CostEvidenceError("RETURN_REVIEW_EVIDENCE_CONFLICT", "Retained return review source fingerprint is invalid.");
        return supplierReturnCreditReviewEntrySchema.parse({ id: costInteger(item.id, "reviewId", 1),
            sourceFingerprint: item.source_fingerprint, expectedVersion: item.expected_version, disposition: item.disposition,
            assignments: item.assignments, evidenceReference: item.evidence_reference, reason: item.reason,
            recordedBy: item.recorded_by, recordedAt: new Date(item.recorded_at).toISOString() });
    });
    const intervals = intervalSchema.parse(entitlement.intervals);
    const quantity = costInteger(entitlement.quantity, "quantity", 1);
    if (intervals.reduce((sum, interval) => sum + interval.quantity, 0) !== quantity) {
        throw new CostEvidenceError("RETURN_CREDIT_QUANTITY_REVIEW", "Return entitlement intervals and quantity disagree.");
    }
    return projectReturnCreditReview({ entitlementId, returnId: Number(row.supplier_return_id), returnLineId: Number(row.id), quantity,
        intervals, currentCosts: costsFor(row, intervals), costEntryIds: evidence.values.get(Number(row.id))!.costEntries.map(entry => entry.id), links, history });
}
