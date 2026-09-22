import { createHash } from "node:crypto";
import { z } from "zod";
import {
  customerReturnEligibilityInputSchema, evaluateCustomerReturnEligibility,
  CustomerReturnEligibilityError,
  type CustomerReturnEligibilityInput, type CustomerReturnEligibilityOutput,
} from "../domain/customer-return-eligibility";
import { customerReturnOrderAccessInputSchema, CustomerReturnOrderAccessError, type CustomerReturnOrderAccessService } from "./customer-return-order-access.service";
import {
  CustomerReturnAuthorizationPersistenceError,
  type CustomerReturnAuthorizationStore, type CustomerReturnAuthorizationResult,
  type LockedCustomerReturnAuthorizationSource, type PersistCustomerReturnAuthorizationInput,
} from "./customer-return-authorization.ports";

const id = z.number().int().positive().safe();
const identity = z.string().trim().min(1).max(255);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const resultSchema = z.object({ authorizationId: id, authorizationNumber: identity, replayed: z.boolean() }).strict();
const selectionSchema = z.object({
  lineId: identity,
  quantity: z.number().int().positive().safe(),
  reasonCode: z.string().trim().min(1).max(80).nullable().default(null),
}).strict();
const prepareInputSchema = customerReturnOrderAccessInputSchema;
const submitInputSchema = prepareInputSchema.extend({
  idempotencyKey: z.string().trim().min(1).max(160),
  eligibilityRevision: sha256,
  lines: z.array(selectionSchema).min(1).max(200),
}).strict().superRefine((input, context) => {
  if (new Set(input.lines.map(line => line.lineId)).size !== input.lines.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "Each purchased line must appear once." });
  }
});

const mappingSchema = z.object({
  lineId: identity, omsOrderLineId: id, externalLineItemId: identity.max(100),
  allocations: z.array(z.object({ allocationId: identity, wmsOrderItemId: id }).strict()).max(200),
}).strict();
const nonnegativeQuantity = z.number().int().nonnegative().safe();
const lockedSourceSchema = z.object({
  channelId: id, omsOrderId: id,
  lines: z.array(z.object({
    omsOrderLineId: id, externalLineItemId: identity.nullable(),
    orderedQuantity: nonnegativeQuantity, legacyExpectedQuantity: nonnegativeQuantity, claimedQuantity: nonnegativeQuantity,
    wmsItems: z.array(z.object({
      wmsOrderId: id, wmsOrderItemId: id, fulfilledQuantity: nonnegativeQuantity,
      legacyExpectedQuantity: nonnegativeQuantity, claimedQuantity: nonnegativeQuantity,
    }).strict()).max(200),
  }).strict()).max(200),
  allocationClaims: z.array(z.object({
    omsOrderLineId: id, fulfillmentId: identity, fulfillmentLineItemId: identity,
    quantity: z.number().int().positive().safe(),
  }).strict()).max(40_000),
}).strict().superRefine((source, context) => {
  const lineIds = source.lines.map(line => line.omsOrderLineId);
  const itemIds = source.lines.flatMap(line => line.wmsItems.map(item => item.wmsOrderItemId));
  const claimIds = source.allocationClaims.map(claim => JSON.stringify([claim.fulfillmentId, claim.fulfillmentLineItemId]));
  if (new Set(lineIds).size !== lineIds.length || new Set(itemIds).size !== itemIds.length || new Set(claimIds).size !== claimIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Locked source identities must be unique." });
  }
  for (const line of source.lines) {
    const expected = line.wmsItems.reduce((sum, item) => sum + item.legacyExpectedQuantity, 0);
    const claimed = line.wmsItems.reduce((sum, item) => sum + item.claimedQuantity, 0);
    if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(claimed)
      || expected !== line.legacyExpectedQuantity || claimed !== line.claimedQuantity) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Locked source quantity totals must balance." });
    }
  }
});
const warehouseSchema = z.object({
  warehouseId: id, version: id,
  address: z.object({
    name: z.string().trim().min(1).max(200),
    address1: z.string().trim().min(1).max(300), address2: z.string().trim().max(300).nullable(),
    city: z.string().trim().min(1).max(100), state: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(20), countryCode: z.literal("US"),
  }).strict(),
}).strict();

export interface CustomerReturnTrustedSource {
  observedAt: string;
  /**
   * Claims here are unlinked external/native Shopify claims ONLY. The reader must
   * exclude native Returns mirrored from an Echelon authorization by exact provider
   * identity, not by SKU/quantity. Echelon claims are read separately under lock.
   */
  facts: Omit<CustomerReturnEligibilityInput, "now">;
  mappings: z.infer<typeof mappingSchema>[];
  warehouse: z.infer<typeof warehouseSchema>;
}
export interface CustomerReturnSourceReader {
  /** Must load complete, paginated trusted facts; never accepts customer-supplied evidence. */
  read(order: Awaited<ReturnType<CustomerReturnOrderAccessService["resolve"]>>): Promise<CustomerReturnTrustedSource>;
}
export interface CustomerReturnAuthorizationDependencies {
  orderAccess: Pick<CustomerReturnOrderAccessService, "resolve">;
  sourceReader: CustomerReturnSourceReader;
  store: CustomerReturnAuthorizationStore;
  clock: () => Date;
  actor: () => Promise<string>;
  maxSourceAgeMs: number;
  /** Composition must keep this closed until every return writer shares quantity claims. */
  isIntakeReady: () => boolean;
  reportFailure?: (event: { operation: "prepare" | "submit"; code: string }) => void;
}
export interface CustomerReturnAuthorizationPreview {
  eligibilityRevision: string;
  eligibility: CustomerReturnEligibilityOutput;
}
export class CustomerReturnAuthorizationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CustomerReturnAuthorizationError";
  }
}

/** Coordinates access, trusted facts and atomic claims; never purchases postage or issues refunds. */
export class CustomerReturnAuthorizationService {
  constructor(private readonly dependencies: CustomerReturnAuthorizationDependencies) {
    z.number().int().positive().safe().parse(dependencies.maxSourceAgeMs);
  }

  async prepare(raw: unknown): Promise<CustomerReturnAuthorizationPreview> {
    return this.boundary("prepare", () => this.prepareInternal(raw));
  }

  async submit(raw: unknown): Promise<CustomerReturnAuthorizationResult> {
    return this.boundary("submit", () => this.submitInternal(raw));
  }

  private async prepareInternal(raw: unknown): Promise<CustomerReturnAuthorizationPreview> {
    const input = parse(prepareInputSchema, raw);
    const order = await this.dependencies.orderAccess.resolve(input);
    const source = await this.loadSource(order);
    return this.dependencies.store.transaction(async tx => {
      const locked = await tx.lockSource({ channelId: order.channelId, omsOrderId: order.omsOrderId,
        omsOrderLineIds: source.mappings.map(mapping => mapping.omsOrderLineId) });
      const facts = this.withCurrentClaims(source, locked, order.omsOrderId);
      return this.preview(source, facts);
    });
  }

  private async submitInternal(raw: unknown): Promise<CustomerReturnAuthorizationResult> {
    const input = parse(submitInputSchema, raw);
    const order = await this.dependencies.orderAccess.resolve({ orderReference: input.orderReference });
    const lines = [...input.lines].sort((left, right) => compare(left.lineId, right.lineId));
    const semanticHash = hash({ channelId: order.channelId, omsOrderId: order.omsOrderId, externalOrderId: order.externalOrderId, lines });
    const command = { channelId: order.channelId, idempotencyKey: input.idempotencyKey };

    // Completed requests remain resumable even when intake is paused or the provider is down.
    const replay = await this.dependencies.store.transaction(async tx => {
      await tx.lockCommand(command);
      return replayResult(await tx.findCommand(command), semanticHash);
    });
    if (replay) return replay;
    if (this.dependencies.isIntakeReady() !== true) throw failure("RETURN_INTAKE_NOT_READY", "New returns are not enabled.");
    const source = await this.loadSource(order); // No network I/O while quantity locks are held.
    const actor = parse(identity, await this.dependencies.actor());
    return this.dependencies.store.transaction(async tx => {
      await tx.lockCommand(command);
      const existing = replayResult(await tx.findCommand(command), semanticHash);
      if (existing) return existing;
      if (this.dependencies.isIntakeReady() !== true) throw failure("RETURN_INTAKE_NOT_READY", "New returns are not enabled.");
      const locked = await tx.lockSource({ channelId: order.channelId, omsOrderId: order.omsOrderId,
        omsOrderLineIds: source.mappings.map(mapping => mapping.omsOrderLineId) });
      const facts = this.withCurrentClaims(source, locked, order.omsOrderId);
      const preview = this.preview(source, facts);
      if (preview.eligibilityRevision !== input.eligibilityRevision) {
        throw failure("RETURN_REVIEW_CHANGED", "The return details changed. Review the current available quantities.");
      }
      const selected = lines.map(request => this.allocate(request, source, preview.eligibility, facts));
      // Audit the same injected decision instant used for the window check under lock.
      const now = new Date(facts.now);
      return parse(resultSchema, await tx.persist({ ...command, omsOrderId: order.omsOrderId, semanticHash,
        eligibilityRevision: preview.eligibilityRevision, actor, now,
        policySnapshot: { ...source.facts.policy, refundAuthority: "manual_shopify", windowBasis: "purchase" },
        warehouseSnapshot: source.warehouse, lines: selected }));
    });
  }

  private async loadSource(order: Awaited<ReturnType<CustomerReturnOrderAccessService["resolve"]>>): Promise<CustomerReturnTrustedSource> {
    const raw = await this.dependencies.sourceReader.read(order);
    const now = this.now();
    const facts = customerReturnEligibilityInputSchema.parse({ ...raw.facts, now: now.toISOString() });
    const mappings = parse(z.array(mappingSchema).min(1).max(200), raw.mappings);
    const warehouse = parse(warehouseSchema, raw.warehouse);
    const observedAt = parse(z.string().datetime({ offset: true }), raw.observedAt);
    if (facts.order.orderId !== order.externalOrderId || facts.order.channelId !== order.channelId
      || facts.policy.channelId !== order.channelId) throw failure("RETURN_SOURCE_MISMATCH", "Return source identity is inconsistent.");
    if (mappings.length !== facts.order.lines.length
      || new Set(mappings.map(mapping => mapping.lineId)).size !== mappings.length
      || new Set(mappings.map(mapping => mapping.omsOrderLineId)).size !== mappings.length) {
      throw failure("RETURN_SOURCE_MISMATCH", "Purchased line mappings must be complete and unambiguous.");
    }
    for (const mapping of mappings) {
      const line = facts.order.lines.find(candidate => candidate.lineId === mapping.lineId);
      const active = line?.allocations.filter(allocation => allocation.status === "active") ?? [];
      if (!line || mapping.externalLineItemId !== line.lineId
        || mapping.allocations.length !== active.length
        || new Set(mapping.allocations.map(allocation => allocation.allocationId)).size !== active.length
        || mapping.allocations.some(allocation => !active.some(fact => fact.allocationId === allocation.allocationId))) {
        throw failure("RETURN_SOURCE_MISMATCH", "Fulfillment mappings must identify each active purchased allocation exactly once.");
      }
    }
    const source = { facts: { policy: facts.policy, order: facts.order }, mappings, warehouse, observedAt };
    this.assertFresh(source, now);
    return source;
  }

  private withCurrentClaims(source: CustomerReturnTrustedSource, locked: LockedCustomerReturnAuthorizationSource | null, omsOrderId: number): CustomerReturnEligibilityInput {
    if (!locked || locked.channelId !== source.facts.order.channelId || locked.omsOrderId !== omsOrderId) {
      throw failure("RETURN_SOURCE_MISMATCH", "The order source is no longer available.");
    }
    locked = parse(lockedSourceSchema, locked);
    const now = this.now();
    this.assertFresh(source, now);
    const lines = source.facts.order.lines.map(line => {
      const mapping = source.mappings.find(candidate => candidate.lineId === line.lineId)!;
      const current = locked.lines.find(candidate => candidate.omsOrderLineId === mapping.omsOrderLineId);
      if (!current || current.externalLineItemId !== mapping.externalLineItemId || current.orderedQuantity !== line.purchasedQuantity) {
        throw failure("RETURN_SOURCE_MISMATCH", "Purchased quantities or identities changed. Reload the order.");
      }
      if (mapping.allocations.some(allocation => !current.wmsItems.some(item => item.wmsOrderItemId === allocation.wmsOrderItemId))) {
        throw failure("RETURN_SOURCE_MISMATCH", "A fulfillment does not belong to the purchased line.");
      }
      const localClaims = locked.allocationClaims.filter(claim => claim.omsOrderLineId === mapping.omsOrderLineId);
      const localQuantity = localClaims.reduce((sum, claim) => sum + claim.quantity, 0);
      if (!Number.isSafeInteger(localQuantity) || localQuantity !== current.claimedQuantity) {
        throw failure("RETURN_SOURCE_MISMATCH", "Current return claims require reconciliation.");
      }
      const claims = line.claims.map(claim => ({ ...claim }));
      // Legacy cases without a proven fulfillment mapping must be reviewed, not guessed.
      if (current.legacyExpectedQuantity > 0) claims.push({ claimId: `legacy:${mapping.omsOrderLineId}`, allocationId: null, quantity: current.legacyExpectedQuantity });
      for (const claim of localClaims) {
        const allocation = line.allocations.find(candidate => candidate.fulfillmentId === claim.fulfillmentId && candidate.fulfillmentLineItemId === claim.fulfillmentLineItemId);
        claims.push({ claimId: `echelon:${hash([claim.fulfillmentId, claim.fulfillmentLineItemId])}`, allocationId: allocation?.allocationId ?? null, quantity: claim.quantity });
      }
      return { ...line, claims };
    });
    return customerReturnEligibilityInputSchema.parse({ ...source.facts, now: now.toISOString(), order: { ...source.facts.order, lines } });
  }

  private preview(source: CustomerReturnTrustedSource, facts: CustomerReturnEligibilityInput): CustomerReturnAuthorizationPreview {
    const eligibility = evaluateCustomerReturnEligibility(facts);
    // Evaluation time itself is not customer intent. Decisions and source evidence are.
    const { evaluatedAt: _evaluatedAt, ...decisions } = eligibility;
    const { now: _now, ...rawEvidence } = facts;
    // Polling the same provider facts again must not invalidate a customer's review.
    // Observation freshness is checked separately; effective facts remain in the hash.
    const evidence = { ...rawEvidence, order: { ...rawEvidence.order,
      lines: rawEvidence.order.lines.map(line => ({ ...line, allocations: line.allocations.map(allocation => ({
        ...allocation, deliveryEvidence: allocation.deliveryEvidence.map(({ observedAt: _observedAt, ...event }) => event),
      })) })),
    } };
    return { eligibility, eligibilityRevision: hash({ evidence, decisions, mappings: source.mappings, warehouse: source.warehouse }) };
  }

  private allocate(request: z.infer<typeof selectionSchema>, source: CustomerReturnTrustedSource,
    eligibility: CustomerReturnEligibilityOutput, facts: CustomerReturnEligibilityInput): PersistCustomerReturnAuthorizationInput["lines"][number] {
    const mapping = source.mappings.find(line => line.lineId === request.lineId);
    const line = eligibility.lines.find(line => line.lineId === request.lineId);
    if (!mapping || !line || request.quantity > line.eligibleQuantity) {
      throw failure("RETURN_QUANTITY_UNAVAILABLE", "A selected quantity is no longer available to return.");
    }
    let remaining = request.quantity;
    const allocations: PersistCustomerReturnAuthorizationInput["lines"][number]["allocations"][number][] = [];
    const rawLine = facts.order.lines.find(line => line.lineId === request.lineId)!;
    for (const allocation of [...line.allocations].sort((left, right) => compare(left.allocationId, right.allocationId))) {
      if (!remaining || !allocation.eligibleQuantity) continue;
      const quantity = Math.min(remaining, allocation.eligibleQuantity);
      const mapped = mapping.allocations.find(candidate => candidate.allocationId === allocation.allocationId);
      const evidence = rawLine.allocations.find(candidate => candidate.allocationId === allocation.allocationId);
      if (!mapped || !evidence) throw failure("RETURN_SOURCE_MISMATCH", "A selected fulfillment mapping is unavailable.");
      allocations.push({ wmsOrderItemId: mapped.wmsOrderItemId, fulfillmentId: allocation.fulfillmentId,
        fulfillmentLineItemId: allocation.fulfillmentLineItemId, quantity,
        eligibleQuantity: allocation.deliveredQuantity,
        deliveryEvidence: { ...evidence, basis: allocation.deliveryBasis, observedAt: source.observedAt } });
      remaining -= quantity;
    }
    if (remaining) throw failure("RETURN_QUANTITY_UNAVAILABLE", "Selected units could not be allocated to delivered fulfillments.");
    return { omsOrderLineId: mapping.omsOrderLineId, externalLineItemId: mapping.externalLineItemId,
      quantity: request.quantity, reasonCode: request.reasonCode, allocations };
  }

  private now(): Date {
    const value = this.dependencies.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw failure("RETURN_CLOCK_INVALID", "The return clock is unavailable.");
    return new Date(value.getTime());
  }
  private async boundary<T>(operation: "prepare" | "submit", work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const classified = error instanceof CustomerReturnAuthorizationError ? error
        : error instanceof CustomerReturnOrderAccessError ? failure(error.code, "The order is unavailable for this access request.")
        : error instanceof CustomerReturnEligibilityError || error instanceof z.ZodError
          ? failure("RETURN_SOURCE_INVALID", "The order information needs to be checked before a return can be started.")
        : error instanceof CustomerReturnAuthorizationPersistenceError ? failure(error.code, "The return could not be saved. Review the current order quantities.")
        : failure("RETURN_SERVICE_UNAVAILABLE", "The return could not be processed. Your request can be retried.");
      const event = { operation, code: classified.code };
      // Never serialize source payloads, customer references, SQL errors or causes.
      try {
        if (this.dependencies.reportFailure) this.dependencies.reportFailure(event);
        else console.error(JSON.stringify({ component: "customer_returns", ...event }));
      } catch {
        console.error(JSON.stringify({ component: "customer_returns", ...event, reportingFailed: true }));
      }
      throw classified;
    }
  }
  private assertFresh(source: CustomerReturnTrustedSource, now: Date): void {
    const age = now.getTime() - Date.parse(source.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > this.dependencies.maxSourceAgeMs) {
      throw failure("RETURN_SOURCE_STALE", "Return source information needs to be refreshed.");
    }
  }
}

function replayResult(existing: { semanticHash: string; result: CustomerReturnAuthorizationResult } | null, semanticHash: string): CustomerReturnAuthorizationResult | null {
  if (!existing) return null;
  if (existing.semanticHash !== semanticHash) throw failure("RETURN_COMMAND_CONFLICT", "This request key belongs to different return selections.");
  return parse(resultSchema, { ...existing.result, replayed: true });
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => compare(JSON.stringify(left), JSON.stringify(right)));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compare(left, right)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
function failure(code: string, message: string): CustomerReturnAuthorizationError { return new CustomerReturnAuthorizationError(code, message); }
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw failure("RETURN_INPUT_INVALID", "The return input is invalid.");
  return result.data;
}
