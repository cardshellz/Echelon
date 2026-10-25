import { and, asc, desc, eq, ilike, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { auditEvents, supplierCredits, supplierCreditLines, supplierCreditApplications, supplierCreditApplicationReversals, vendorInvoices } from "@shared/schema";
import { supplierCreditApplyInputSchema, supplierCreditCreateInputSchema, supplierCreditReviewInputSchema, supplierCreditIdSchema, supplierCreditLineSourceKey, supplierCreditListQuerySchema, supplierCreditListSchema, type SupplierCreditCommand, type SupplierCreditCreateInput, type SupplierCreditApplyInput, type SupplierCreditDetail } from "@shared/procurement/supplier-credit";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import { recalculateInvoiceBalance, recomputeLinkedPurchaseOrders } from "./ap-ledger.service";
import { assertInvoiceSettlementEvidence } from "./supplier-credit-settlement.repository";
import { approveSupplierCreditSources, validateSupplierCreditSourceLines, voidSupplierCreditSources, createSupplierCreditCostReadCache } from "./supplier-credit-source.service";
import { creditHash, loadSupplierCredit, loadSupplierCreditSource, readSupplierCreditDetail, readSupplierCreditOptions, SupplierCreditError, type CreditTransaction } from "./supplier-credit.repository";
export type SupplierCreditCommandInput = {
  command: SupplierCreditCommand;
  raw: unknown;
  actorId: string;
  creditId?: number;
  applicationId?: number;
  at: Date;
};
const exactTotal = (values: readonly number[]) => Number(values.reduce((sum, value) => sum + BigInt(value), BigInt(0)));
function assertSource(source: Awaited<ReturnType<typeof loadSupplierCreditSource>>) {
  if (source.invoice.currency !== "USD" || !["approved", "partially_paid", "paid"].includes(source.invoice.status)) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_REQUIRED", "An approved USD supplier invoice is required.");
}
function assertSourceCapacity(source: Awaited<ReturnType<typeof loadSupplierCreditSource>>, lines: {
  invoiceLineId: number;
  amountCents: number;
}[]) {
  const requested = new Map<number, bigint>();
  for (const line of lines) requested.set(line.invoiceLineId, (requested.get(line.invoiceLineId) ?? BigInt(0)) + BigInt(line.amountCents));
  for (const [id, amount] of requested) {
    const line = source.lines.find(row => row.id === id);
    if (!line || !Number.isSafeInteger(line.lineTotalCents) || line.lineTotalCents < 0 || amount + BigInt(source.credited.get(id) ?? 0) > BigInt(line.lineTotalCents)) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_EXCEEDED", "Credit exceeds the remaining documented amount on an original invoice line.");
  }
}
async function refreshInvoices(tx: CreditTransaction, ids: readonly number[], actorId: string, reason: string, at: Date) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    await recalculateInvoiceBalance(id, tx, at);
    await recomputeLinkedPurchaseOrders(id, tx, {
      actorId,
      reason,
      now: at
    });
  }
}
type ExistingCredit = Awaited<ReturnType<typeof loadSupplierCredit>>;
type CreditReview = {
  expectedVersion: string;
  reason: string;
};
async function createCreditDraft(tx: CreditTransaction, input: SupplierCreditCommandInput, data: SupplierCreditCreateInput): Promise<number> {
  const source = await loadSupplierCreditSource(tx, data.sourceInvoiceId, true);
  assertSource(source);
  if (source.version !== data.expectedSourceVersion) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_STALE", "The original invoice or prior credits changed. Reload and review its current evidence.");
  const existing = await tx.select().from(supplierCredits).where(and(eq(supplierCredits.vendorId, source.invoice.vendorId), eq(supplierCredits.supplierReference, data.supplierReference))).orderBy(asc(supplierCredits.id)).for("update");
  if (data.replacesCreditId) {
    const predecessor = existing.find(row => row.id === data.replacesCreditId);
    if (!predecessor || predecessor.status !== "voided" || existing.some(row => row.replacesCreditId === predecessor.id) || existing.some(row => row.status !== "voided")) throw new SupplierCreditError("SUPPLIER_CREDIT_REPLACEMENT_INVALID", "Choose the latest voided document for this exact supplier reference; a replacement must not already exist.");
  } else if (existing.length) throw new SupplierCreditError("SUPPLIER_CREDIT_DUPLICATE", "This supplier reference already has retained history. Use its explicit replacement action after voiding it.");
  assertSourceCapacity(source, data.lines);
  const evidence = await validateSupplierCreditSourceLines(tx, {
    invoiceId: data.sourceInvoiceId,
    lines: data.lines,
    actorId: input.actorId,
    at: input.at
  });
  if (evidence.length !== data.lines.length) throw new Error("Supplier credit source validation omitted a line.");
  const [created] = await tx.insert(supplierCredits).values({
    sourceInvoiceId: data.sourceInvoiceId,
    vendorId: source.invoice.vendorId,
    sourceSnapshot: source.sourceSnapshot,
    replacesCreditId: data.replacesCreditId ?? null,
    supplierReference: data.supplierReference,
    creditCalendarDate: data.creditCalendarDate,
    totalAmountCents: exactTotal(data.lines.map(row => row.amountCents)),
    currency: "USD",
    status: "draft",
    version: 1,
    reason: data.reason,
    createdBy: input.actorId,
    createdAt: input.at
  }).returning();
  await tx.insert(supplierCreditLines).values(data.lines.map((line, index) => ({
    supplierCreditId: created.id,
    invoiceLineId: line.invoiceLineId,
    sourceKey: supplierCreditLineSourceKey(line),
    amountCents: line.amountCents,
    disposition: line.disposition,
    sourceEvidence: evidence[index].sourceEvidence,
    costState: evidence[index].costState,
    costIssues: evidence[index].costIssues,
    createdAt: input.at
  })));
  return created.id;
}
async function approveCredit(tx: CreditTransaction, input: SupplierCreditCommandInput, credit: ExistingCredit, current: SupplierCreditDetail) {
  const creditId = credit.id;
  if (!current.capabilities.approve.allowed) throw new SupplierCreditError("SUPPLIER_CREDIT_APPROVAL_REQUIRED", current.capabilities.approve.reason);
  const source = await loadSupplierCreditSource(tx, credit.sourceInvoiceId, true);
  assertSource(source);
  if (creditHash(source.sourceSnapshot) !== creditHash(credit.sourceSnapshot)) throw new SupplierCreditError("SUPPLIER_CREDIT_SOURCE_STALE", "The original invoice economics changed after this credit was drafted.");
  assertSourceCapacity(source, current.lines);
  await tx.update(supplierCredits).set({
    status: "approved",
    approvedBy: input.actorId,
    approvedAt: input.at,
    version: credit.version + 1
  }).where(eq(supplierCredits.id, creditId));
  await approveSupplierCreditSources(tx, {
    creditId,
    actorId: input.actorId,
    at: input.at
  });
}
async function reconcileCreditCosts(
  tx: CreditTransaction,
  input: SupplierCreditCommandInput,
  credit: ExistingCredit,
  current: SupplierCreditDetail,
): Promise<void> {
  if (!current.capabilities.reconcileCosts?.allowed) {
    throw new SupplierCreditError(
      "SUPPLIER_CREDIT_COST_RECONCILIATION_UNAVAILABLE",
      current.capabilities.reconcileCosts?.reason ?? "This credit is unavailable for cost reconciliation.",
    );
  }
  // Re-evaluate the existing approved source; do not approve the document again,
  // increment its financial version, or repeat a physical/settlement action.
  // An unchanged review outcome may legitimately retain the same detail version.
  await approveSupplierCreditSources(tx, {
    creditId: credit.id,
    actorId: input.actorId,
    at: input.at,
  });
}
async function applyCredit(tx: CreditTransaction, input: SupplierCreditCommandInput, credit: ExistingCredit, current: SupplierCreditDetail, data: SupplierCreditApplyInput): Promise<number[]> {
  const creditId = credit.id;
  if (!current.capabilities.apply.allowed || current.unappliedAmountCents === null) throw new SupplierCreditError("SUPPLIER_CREDIT_UNAVAILABLE", current.capabilities.apply.reason);
  if (exactTotal(data.allocations.map(row => row.appliedAmountCents)) > current.unappliedAmountCents) throw new SupplierCreditError("SUPPLIER_CREDIT_OVERAPPLIED", "Applications exceed the remaining supplier credit.");
  const ids = data.allocations.map(row => row.vendorInvoiceId).sort((a, b) => a - b);
  const invoices = await tx.select().from(vendorInvoices).where(inArray(vendorInvoices.id, ids)).orderBy(asc(vendorInvoices.id)).for("update");
  for (const allocation of data.allocations) {
    const invoice = invoices.find(row => row.id === allocation.vendorInvoiceId);
    if (!invoice || invoice.vendorId !== credit.vendorId || invoice.currency !== credit.currency || !["approved", "partially_paid"].includes(invoice.status)) throw new SupplierCreditError("SUPPLIER_CREDIT_TARGET_INVALID", "Apply credit only to an approved payable USD invoice for the same supplier.");
    await assertInvoiceSettlementEvidence(tx, invoice);
    if (allocation.appliedAmountCents > invoice.balanceCents) throw new SupplierCreditError("SUPPLIER_CREDIT_INVOICE_EXCEEDED", "Application exceeds the invoice's verified outstanding balance.");
  }
  const rows = await tx.insert(supplierCreditApplications).values(data.allocations.map(row => ({
    ...row,
    supplierCreditId: creditId!,
    actorId: input.actorId,
    recordedAt: input.at,
    reason: data.reason
  }))).returning({
    id: supplierCreditApplications.id
  });
  await refreshInvoices(tx, ids, input.actorId, data.reason, input.at);
  await tx.update(supplierCredits).set({
    version: credit.version + 1
  }).where(eq(supplierCredits.id, creditId));
  return rows.map(row => row.id);
}
async function reverseCreditApplication(tx: CreditTransaction, input: SupplierCreditCommandInput, credit: ExistingCredit, current: SupplierCreditDetail, review: CreditReview): Promise<number> {
  const creditId = credit.id;
  const applicationId = supplierCreditIdSchema.parse(input.applicationId);
  const app = current.applications.find(row => row.id === applicationId);
  if (!app || !app.canReverse.allowed) throw new SupplierCreditError("SUPPLIER_CREDIT_REVERSAL_UNAVAILABLE", "The selected application is unavailable for reversal.");
  const [invoice] = await tx.select().from(vendorInvoices).where(eq(vendorInvoices.id, app.vendorInvoiceId)).for("update");
  if (!invoice || invoice.status === "voided") throw new SupplierCreditError("SUPPLIER_CREDIT_TARGET_INVALID", "The applied invoice needs review before reversal.");
  await assertInvoiceSettlementEvidence(tx, invoice);
  await tx.insert(supplierCreditApplicationReversals).values({
    applicationId,
    actorId: input.actorId,
    recordedAt: input.at,
    reason: review.reason
  });
  await refreshInvoices(tx, [app.vendorInvoiceId], input.actorId, review.reason, input.at);
  await tx.update(supplierCredits).set({
    version: credit.version + 1
  }).where(eq(supplierCredits.id, creditId));
  return applicationId;
}
async function voidCredit(tx: CreditTransaction, input: SupplierCreditCommandInput, credit: ExistingCredit, current: SupplierCreditDetail, review: CreditReview) {
  const creditId = credit.id;
  if (!current.capabilities.void.allowed) throw new SupplierCreditError("SUPPLIER_CREDIT_VOID_UNAVAILABLE", current.capabilities.void.reason);
  await tx.update(supplierCredits).set({
    status: "voided",
    voidedBy: input.actorId,
    voidedAt: input.at,
    voidReason: review.reason,
    version: credit.version + 1
  }).where(eq(supplierCredits.id, creditId));
  if (credit.status === "approved") await voidSupplierCreditSources(tx, {
    creditId,
    actorId: input.actorId,
    at: input.at
  });
}
/** The graph lock, current authorization, document, invoice settlement, source cost
 * revisions and immutable audit share the durable command transaction. */
export async function executeSupplierCreditCommand(tx: CreditTransaction, input: SupplierCreditCommandInput) {
  await lockInventoryCostGraph(tx);
  const authority = await readCommandAuthorityActor(tx, input.actorId);
  const permission = input.command === "create" ? "purchasing:edit" : "purchasing:approve";
  if (!authority.active || !authority.permissions.includes(permission)) throw new SupplierCreditError("SUPPLIER_CREDIT_AUTHORITY_REQUIRED", `Current ${permission} permission is required.`, 403);
  if (!Number.isFinite(input.at.getTime())) throw new Error("Supplier credit command clock is invalid.");
  const parsed = input.command === "create" ? supplierCreditCreateInputSchema.safeParse(input.raw) : input.command === "apply" ? supplierCreditApplyInputSchema.safeParse(input.raw) : supplierCreditReviewInputSchema.safeParse(input.raw);
  if (!parsed.success) throw new SupplierCreditError("SUPPLIER_CREDIT_INPUT_INVALID", "Review every required field and exact supplier credit amount.", 422);
  const request = parsed.data;
  let creditId = input.creditId;
  const applicationIds: number[] = [];
  let reversedApplicationId: number | null = null;
  let before: unknown = null;
  if (input.command === "create") {
    creditId = await createCreditDraft(tx, input, supplierCreditCreateInputSchema.parse(request));
  } else {
    creditId = supplierCreditIdSchema.parse(creditId);
    const credit = await loadSupplierCredit(tx, creditId, true);
    const current = await readSupplierCreditDetail(tx, creditId, true);
    before = current;
    const review = supplierCreditReviewInputSchema.parse(input.command === "apply" ? {
      expectedVersion: supplierCreditApplyInputSchema.parse(request).expectedVersion,
      reason: request.reason
    } : request);
    if (current.version !== review.expectedVersion) throw new SupplierCreditError("SUPPLIER_CREDIT_STALE", "Credit evidence changed. Reload and review the current balance and history.");
    if (current.balanceState === "review_required") throw new SupplierCreditError("SUPPLIER_CREDIT_EVIDENCE_REVIEW", "Resolve the credit evidence before changing this document.");
    if (input.command === "approve") {
      await approveCredit(tx, input, credit, current);
    } else if (input.command === "reconcile_costs") {
      await reconcileCreditCosts(tx, input, credit, current);
    } else if (input.command === "apply") {
      applicationIds.push(...(await applyCredit(tx, input, credit, current, supplierCreditApplyInputSchema.parse(request))));
    } else if (input.command === "reverse") {
      reversedApplicationId = await reverseCreditApplication(tx, input, credit, current, review);
    } else {
      await voidCredit(tx, input, credit, current, review);
    }
  }
  const id = supplierCreditIdSchema.parse(creditId);
  const credit = await readSupplierCreditDetail(tx, id, authority.permissions.includes("purchasing:approve"), authority.permissions.includes("purchasing:edit"));
  await tx.insert(auditEvents).values({
    actor: input.actorId,
    action: `ap_ledger.supplier_credit.${input.command}`,
    target: `supplier_credit:${id}`,
    timestamp: input.at,
    level: "AUDIT",
    changes: null,
    context: {
      command: input.command,
      creditId: id,
      request,
      before,
      after: credit,
      applicationIds,
      reversedApplicationId
    }
  });
  return {
    creditId: id,
    request,
    applicationIds,
    reversedApplicationId,
    credit
  };
}
export function createSupplierCreditReader(clock: () => Date = () => new Date()) {
  async function read<T>(actorId: string, work: (tx: CreditTransaction, permissions: readonly string[]) => Promise<T>) {
    return db.transaction(async tx => {
      const authority = await readCommandAuthorityActor(tx, actorId, {
        lock: false
      });
      const permissions = authority.active ? authority.permissions : [];
      if (!permissions.includes("purchasing:view")) throw new SupplierCreditError("SUPPLIER_CREDIT_VIEW_REQUIRED", "Current purchasing view permission is required.", 403);
      return work(tx, permissions);
    }, {
      isolationLevel: "repeatable read",
      accessMode: "read only"
    });
  }
  return {
    detail: (id: number, actorId: string) => read(actorId, (tx, permissions) => readSupplierCreditDetail(tx, supplierCreditIdSchema.parse(id), permissions.includes("purchasing:approve"), permissions.includes("purchasing:edit"))),
    options: (invoiceId: number, actorId: string) => read(actorId, (tx, permissions) => readSupplierCreditOptions(tx, supplierCreditIdSchema.parse(invoiceId), actorId, permissions.includes("purchasing:edit"), clock())),
    list: (raw: unknown, actorId: string) => read(actorId, async (tx, permissions) => {
      const query = supplierCreditListQuerySchema.parse(raw);
      const filters: SQL[] = [];
      if (query.vendorId) filters.push(eq(supplierCredits.vendorId, query.vendorId));
      if (query.sourceInvoiceId) filters.push(eq(supplierCredits.sourceInvoiceId, query.sourceInvoiceId));
      // Related invoices include retained reversed applications so their history remains reachable.
      if (query.invoiceId) filters.push(sql`(${supplierCredits.sourceInvoiceId}=${query.invoiceId}
        OR EXISTS (SELECT 1 FROM ${supplierCreditApplications} related
          WHERE related.supplier_credit_id=${supplierCredits.id} AND related.vendor_invoice_id=${query.invoiceId}))`);
      if (query.status) filters.push(eq(supplierCredits.status, query.status));
      if (query.search) filters.push(ilike(supplierCredits.supplierReference, `%${query.search.replace(/[\\%_]/g, "\\$&")}%`));
      const [count] = await tx.select({
        total: sql<number>`count(*)`
      }).from(supplierCredits).where(and(...filters));
      const ids = await tx.select({
        id: supplierCredits.id
      }).from(supplierCredits).where(and(...filters)).orderBy(desc(supplierCredits.id)).limit(query.limit).offset(query.offset);
      const items = [];
      const costCache = createSupplierCreditCostReadCache(tx);
      for (const row of ids) items.push(await readSupplierCreditDetail(tx, row.id, permissions.includes("purchasing:approve"), permissions.includes("purchasing:edit"), costCache));
      const total = Number(count.total);
      return supplierCreditListSchema.parse({
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        nextOffset: query.offset + items.length < total ? query.offset + items.length : null
      });
    })
  };
}
export const supplierCreditReader = createSupplierCreditReader();
