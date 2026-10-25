import type { VerifiedCustodyResult, CustodyAction } from "../../shared/procurement/receiving-quarantine-command";
import type { Page } from "@playwright/test";
import type { ReceivingQuarantineCommandResult, ReceivingQuarantineObservation, ReceivingQuarantineView } from "../../shared/procurement/receiving-quarantine";
import { installFixtures, receipt } from "./procurement-fixtures";

const allowed = { allowed: true, reason: null };
const denied = { allowed: false, reason: "This action requires purchasing approval." };
const timestamp = "2026-10-14T12:00:00.000Z";
export const quarantineLocations = [
  { id: 5, code: "RCV-01", name: "Receiving", warehouseId: 1, isActive: 1 },
  { id: 6, code: "HOLD-01", name: "Held goods", warehouseId: 1, isActive: 1 },
  { id: 8, code: "OTHER-01", name: "Other warehouse", warehouseId: 2, isActive: 1 },
  { id: 9, code: "CLOSED-01", name: "Inactive", warehouseId: 1, isActive: 0 },
  { id: 10, code: "EXTERNAL-01", name: "External availability", warehouseId: 1, isActive: 1, locationType: "3pl_virtual" },
];

export function custodyObservation(): ReceivingQuarantineObservation {
  return { id: 41, receivingOrderId: 31, receivingLineId: null, warehouseId: 1, holdingLocationId: 6,
    holdingLocationLabel: "HOLD-01", productId: null, productVariantId: null, unitsPerVariant: null,
    purchaseOrderLineId: null, inboundShipmentLineId: null, description: "Unidentified sealed cartons", observedSku: "UNKNOWN-SKU",
    unitLabel: "sealed cartons", condition: "unexpected", observedQty: 3, unallocatedQty: 3,
    awaitingReceiptQty: 0, receivedQty: 0, returnedQty: 0, physicalHeldQty: 3, version: 0,
    reason: "Arrived without an identified purchase source", evidenceReference: "PHOTO-101", actorId: "receiver", recordedAt: timestamp,
    canPrepareAcceptance: allowed, canReturn: allowed, acceptances: [], dispositions: [] };
}

export interface QuarantineFixtureOptions { existing?: boolean; closed?: boolean; lostOnce?: boolean; invalidOnce?: boolean; rejected?: boolean; delayed?: boolean; denied?: boolean; optionsInvalid?: boolean; }

export async function installQuarantineFixtures(page: Page, options: QuarantineFixtureOptions = {}) {
  const failures = await installFixtures(page);
  const line = { id: 7, receivingOrderId: 31, sku: "TEST-CASE", productName: "Test product", productId: 10, productVariantId: 2,
    unitsPerVariantSnapshot: 10, unitVersion: "a".repeat(64), expectedQty: 10, receivedQty: 4, damagedQty: 2,
    status: "partial", putawayLocationId: 5, putawayComplete: 0, unitCost: 25, notes: null, purchaseOrderLineId: 9 };
  const state = {
    order: { ...receipt(31), status: options.closed ? "closed" : "receiving", warehouseId: 1, receivingLocationId: 5, sourceType: "po", inboundShipmentId: null, lines: [line] },
    view: { receivingOrderId: 31, warehouseId: 1, canRecord: allowed, canAcceptAll: allowed,
      observations: options.existing ? [custodyObservation()] : [] } as ReceivingQuarantineView,
    commands: [] as Array<{ path: string; key: string | undefined; body: Record<string, unknown> }>,
    reads: 0, optionReads: [] as string[], actorId: "test-user", detailFailure: 0, failureStatuses: [] as number[],
  };
  if (options.denied && state.view.observations[0]) {
    state.view.canRecord = denied;
    state.view.observations[0].canPrepareAcceptance = denied;
    state.view.observations[0].canReturn = denied;
  }
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const saved = new Map<string, VerifiedCustodyResult>();
  let responseLost = false, invalidSent = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === "GET") {
      if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: state.actorId, username: state.actorId, role: "admin" }, permissions: [], roles: ["admin"] } });
      if (path === "/api/receiving/31") { state.reads++; return state.detailFailure ? route.fulfill({ status: state.detailFailure, json: { error: "Receipt detail unavailable" } }) : route.fulfill({ json: state.order }); }
      if (path === "/api/receiving/32") return route.fulfill({ json: { ...state.order, id: 32, receiptNumber: "OTHER-RECEIPT", lines: [] } });
      if (path === "/api/receiving/31/quarantine") return route.fulfill({ json: state.view });
      if (path === "/api/receiving/32/quarantine") return route.fulfill({ json: { ...state.view, receivingOrderId: 32,
        observations: state.view.observations.filter((observation) => observation.acceptances.some((acceptance) => acceptance.receivingOrderId === 32)) } });
      if (path === "/api/receiving/31/quarantine/acceptance-options") {
        state.optionReads.push(url.search);
        if (options.optionsInvalid) return route.fulfill({ json: { items: [{}], nextCursor: null } });
        return route.fulfill({ json: { items: [{ receivingLineId: 7, unitVersion: "a".repeat(64), targetReceivingOrderId: null,
          receiptNumber: "TEST-RECEIPT-31", productId: 10, productVariantId: 2, sku: "TEST-CASE", productName: "Test product",
          unitsPerVariant: 10, purchaseOrderLineId: 9, inboundShipmentLineId: null, putawayLocationId: 5 }], nextCursor: url.searchParams.has("cursor") ? null : 7 } });
      }
      if (path === "/api/warehouse/locations") return route.fulfill({ json: quarantineLocations });
      if (path === "/api/warehouses") return route.fulfill({ json: [{ id: 1, code: "W1", name: "Main" }] });
      if (path === "/api/product-variants") return route.fulfill({ json: [{ id: 2, sku: "TEST-CASE", name: "Case", productId: 10, unitsPerVariant: 10 }] });
      return route.fallback();
    }
    if (request.method() !== "POST" || !path.includes("quarantine")) return route.fallback();
    const body = request.postDataJSON() as Record<string, unknown>, key = request.headers()["idempotency-key"];
    state.commands.push({ path, body, key });
    const command = (path === "/api/receiving/31/quarantine" ? "intake" : path.split("/").at(-1)) as CustodyAction;
    const identity = { command, resourceId: command === "intake" ? 31 : 41, actorId: state.actorId, idempotencyKey: key! };
    const failureStatus = state.failureStatuses.shift();
    if (failureStatus) return route.fulfill({ status: failureStatus, json: { error: "Session or permission needs recovery", code: failureStatus === 409 ? "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" : "AUTH_REQUIRED" } });
    if (options.delayed) await gate;
    if (options.rejected) return route.fulfill({ status: 409, json: { error: "Receipt counts changed. Load the latest receipt before recording custody.", code: "RECEIVING_UNIT_VERSION_CONFLICT", details: { custodyCommandOutcome: "rejected", ...identity } } });
    let result = key ? saved.get(key) : undefined;
    if (!result) {
      if (path === "/api/receiving/31/quarantine") {
        const observation = custodyObservation();
        Object.assign(observation, { actorId: state.actorId, reason: body.reason, evidenceReference: body.evidenceReference, holdingLocationId: body.holdingLocationId, condition: body.condition });
        if (body.kind === "receipt_line") {
          Object.assign(observation, { receivingLineId: 7, productId: 10, productVariantId: 2, unitsPerVariant: 10, purchaseOrderLineId: 9,
            description: "Test product", observedSku: "TEST-CASE", unitLabel: "receive units", condition: body.condition,
            observedQty: body.heldQty, unallocatedQty: body.heldQty, physicalHeldQty: body.heldQty });
          state.order.lines[0].receivedQty = Number(body.acceptedQty); state.order.lines[0].damagedQty = 0; state.order.lines[0].unitVersion = "b".repeat(64);
        } else Object.assign(observation, { description: body.description, observedSku: body.observedSku, unitLabel: body.unitLabel, observedQty: body.quantity, unallocatedQty: body.quantity, physicalHeldQty: body.quantity });
        state.view.observations.push(observation);
        state.view.canAcceptAll = { allowed: false, reason: "Quarantine has explicit accepted counts. Confirm lines individually." };
      }
      const observation = state.view.observations[0];
      let acceptance: ReceivingQuarantineCommandResult["acceptance"] = null;
      if (path.endsWith("prepare-acceptance")) {
        const qty = Number(body.observationQty);
        const targetReceiptId = body.targetReceivingOrderId === null ? options.closed ? 32 : 31 : Number(body.targetReceivingOrderId);
        acceptance = { id: 61, observationQty: qty, receivingOrderId: targetReceiptId, receiptNumber: targetReceiptId === 31 ? "TEST-RECEIPT-31" : "PENDING-32", receivingLineId: 70,
          productVariantId: 2, unitsPerVariant: 10, acceptedVariantQty: Number(body.acceptedVariantQty), status: "awaiting_receipt", createdAt: timestamp, canCancel: allowed };
        observation.acceptances.push(acceptance); observation.unallocatedQty -= qty; observation.awaitingReceiptQty += qty; observation.version++;
      } else if (path.endsWith("cancel-acceptance")) {
        const current = observation.acceptances.find((item) => item.id === body.acceptanceId)!;
        current.status = "cancelled"; current.canCancel = { allowed: false, reason: "Already cancelled." };
        observation.unallocatedQty += current.observationQty; observation.awaitingReceiptQty -= current.observationQty; observation.version++;
        acceptance = current;
      } else if (path.endsWith("/return")) {
        const qty = Number(body.observationQty);
        observation.unallocatedQty -= qty; observation.physicalHeldQty -= qty; observation.returnedQty += qty; observation.version++;
      }
      if (command !== "intake") observation.dispositions.push({ id: observation.dispositions.length + 1,
        kind: command === "prepare-acceptance" ? "prepare_acceptance" : command === "cancel-acceptance" ? "cancel_acceptance" : "return",
        observationQty: Number(body.observationQty ?? acceptance?.observationQty), actorId: state.actorId, recordedAt: timestamp,
        reason: String(body.reason), evidenceReference: command === "return" ? String(body.evidenceReference) : null, acceptanceId: acceptance?.id ?? null });
      result = structuredClone({ observation, acceptance, ...identity, request: body });
      if (key) saved.set(key, result);
    }
    if (options.lostOnce && !responseLost) { responseLost = true; return route.abort("connectionreset"); }
    if (options.invalidOnce && !invalidSent) { invalidSent = true; return route.fulfill({ json: { success: true } }); }
    return route.fulfill({ json: result });
  });
  await page.goto("/receiving?open=31");
  return { state, failures, release };
}
