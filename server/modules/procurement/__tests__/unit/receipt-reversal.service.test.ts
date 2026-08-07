import { describe, it, expect, vi } from "vitest";
import {
  ReceiptReversalService,
  ReceiptReversalError,
  __testing__,
} from "../../receipt-reversal.service";

/**
 * Spec D, Part 1 — receipt reversal math.
 *
 * Covers:
 *   - partial reversal (qty < remaining)
 *   - full reversal (qty == remaining)
 *   - double-reverse attempt (exceeds remaining → 409)
 *   - consumed-lot block (insufficient on-hand → 409; allowNegative override)
 *   - PO status re-evaluation (received → partially_received)
 *   - idempotent retry (same idempotency key → no double-apply)
 *   - dogfood case: 360 "cases" credited as 360 pieces, reversed, PO line
 *     received_qty decremented by qty × units_per_variant
 *   - pure status re-evaluation helpers
 */

// ── Harness ─────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

function makeHarness(opts: {
  line?: Row;
  order?: Row;
  variant?: Row;
  poLine?: Row;
  po?: Row;
  poLines?: Row[];
  lots?: Row[];
  level?: Row | null;
  existingReversals?: Row[];
  apMatchedRows?: Row[];
}) {
  const line = {
    id: 1001,
    receiving_order_id: 100,
    received_qty: 360,
    reversed_qty: 0,
    product_variant_id: 11,
    purchase_order_line_id: 5001,
    putaway_location_id: 7,
    order_status: "closed",
    order_po_id: 123,
    receipt_number: "RCV-20260807-001",
    ...opts.line,
  };
  const order = {
    id: 100,
    status: "closed",
    purchase_order_id: 123,
    ...opts.order,
  };
  const variant = {
    id: 11,
    units_per_variant: 1,
    ...opts.variant,
  };
  const poLine = {
    id: 5001,
    purchase_order_id: 123,
    order_qty: 270000,
    received_qty: 360,
    damaged_qty: 0,
    cancelled_qty: 0,
    status: "partially_received",
    ...opts.poLine,
  };
  const po = {
    id: 123,
    status: "partially_received",
    physical_status: "receiving",
    ...opts.po,
  };
  const lots = opts.lots ?? [
    { id: 9001, qty_on_hand: 360, unit_cost_mills: 375, warehouse_location_id: 7 },
  ];
  const level = opts.level === undefined
    ? { id: 301, variant_qty: 360 }
    : opts.level;
  const existingReversals = opts.existingReversals ?? [];
  const apMatchedRows = opts.apMatchedRows ?? [];

  // Mutation trackers
  const updates: Array<{ sqlText: string; params: any[] }> = [];
  const inserts: Array<{ sqlText: string; params: any[] }> = [];
  const state = {
    poLineReceivedQty: poLine.received_qty,
    poLineStatus: poLine.status,
    lineReversedQty: line.reversed_qty,
    lotOnHand: lots.map((l) => ({ ...l })),
    levelQty: level ? level.variant_qty : null,
    poStatus: po.status,
    poPhysicalStatus: po.physical_status,
    reversalIdSeq: 1,
    insertedReversals: [] as Row[],
    insertedTransactions: [] as Row[],
    insertedHistory: [] as Row[],
    apReopened: 0,
  };

  // The inventory module's public reversal API — mocked at the same boundary
  // the production wiring uses (writer-ratchet: procurement never touches
  // inventory.* tables). Applies the lot/level mutations to the harness state
  // so the assertions read the same way as before.
  const inventoryCore = {
    reverseReceiptInventory: vi.fn(async (params: any, _tx?: any) => {
      const totalOnHand = state.lotOnHand.reduce((s, l) => s + Math.max(0, l.qty_on_hand), 0);
      const levelQty = state.levelQty ?? 0;
      const available = Math.min(totalOnHand, levelQty || totalOnHand);
      if (!params.allowNegative && (totalOnHand < params.qty || (state.levelQty !== null && levelQty < params.qty))) {
        const err: any = new Error(
          `Insufficient on-hand to reverse ${params.qty} unit(s): only ${available} available.`,
        );
        err.code = "REVERSAL_INSUFFICIENT_ON_HAND";
        err.context = { receivingLineId: params.receivingLineId, qty: params.qty, available };
        throw err;
      }
      let remaining = params.qty;
      for (const lot of state.lotOnHand) {
        if (remaining <= 0) break;
        const dec = Math.min(remaining, params.allowNegative ? remaining : lot.qty_on_hand);
        lot.qty_on_hand -= dec;
        remaining -= dec;
      }
      if (state.levelQty !== null) state.levelQty -= params.qty;
      state.insertedTransactions.push({ params });
      return { lotUnitCostMills: state.lotOnHand[0]?.unit_cost_mills ?? null };
    }),
  };

  // Tiny SQL-router: matches on the normalized query text.
  const route = (query: any): { rows: any[] } => {
    // Drizzle SQL object: queryChunks is an array of StringChunk
    // ({value: ["..."]}) interleaved with raw parameter values.
    let text = "";
    const params: any[] = [];
    for (const chunk of query?.queryChunks ?? []) {
      if (chunk && Array.isArray(chunk.value)) {
        text += chunk.value.join("");
      } else {
        text += "?";
        params.push(chunk);
      }
    }
    const t = text.replace(/\s+/g, " ").trim();

    // Idempotency pre-check (order-scoped LIKE first, then exact key).
    if (t.includes("FROM procurement.receipt_reversals") && t.includes("idempotency_key LIKE")) {
      // Params: receiving_order_id, prefix-with-%.
      const prefix = String(params[params.length - 1]).replace(/%$/, "");
      const rows = state.insertedReversals.filter((r) => String(r.idempotency_key).startsWith(prefix));
      return { rows };
    }
    if (t.includes("FROM procurement.receipt_reversals") && t.includes("idempotency_key =")) {
      const key = params[0];
      const rows = state.insertedReversals.filter((r) => r.idempotency_key === key);
      return { rows: rows.length ? rows : existingReversals.filter((r) => r.idempotency_key === key) };
    }

    // Order lock (reverseReceivingOrder).
    if (t.includes("FROM procurement.receiving_orders") && t.includes("FOR UPDATE") && !t.includes("JOIN")) {
      return { rows: [order] };
    }

    // Lines for whole-order reversal.
    if (t.includes("FROM procurement.receiving_lines") && t.includes("receiving_order_id =") && t.includes("FOR UPDATE") && !t.includes("JOIN")) {
      return {
        rows: [{
          id: line.id,
          received_qty: line.received_qty,
          reversed_qty: state.lineReversedQty,
        }],
      };
    }

    // Line + order join lock.
    if (t.includes("FROM procurement.receiving_lines rl") && t.includes("JOIN procurement.receiving_orders")) {
      return { rows: [{ ...line, reversed_qty: state.lineReversedQty }] };
    }

    // Variant lookup.
    if (t.includes("FROM catalog.product_variants") && t.includes("units_per_variant")) {
      return { rows: [variant] };
    }

    // reversed_qty increment.
    if (t.startsWith("UPDATE procurement.receiving_lines") && t.includes("reversed_qty = reversed_qty +")) {
      state.lineReversedQty += params[0];
      updates.push({ sqlText: t, params });
      return { rows: [] };
    }

    // PO line lock.
    if (t.includes("FROM procurement.purchase_order_lines") && t.includes("FOR UPDATE")) {
      return {
        rows: [{
          ...poLine,
          received_qty: state.poLineReceivedQty,
          status: state.poLineStatus,
        }],
      };
    }

    // PO line update.
    if (t.startsWith("UPDATE procurement.purchase_order_lines")) {
      state.poLineReceivedQty = params[0];
      state.poLineStatus = params[1];
      updates.push({ sqlText: t, params });
      return { rows: [] };
    }

    // AP re-open.
    if (t.startsWith("UPDATE procurement.vendor_invoice_lines")) {
      state.apReopened = apMatchedRows.length;
      updates.push({ sqlText: t, params });
      return { rows: apMatchedRows.map((r) => ({ id: r.id })) };
    }

    // Reversal insert.
    if (t.startsWith("INSERT INTO procurement.receipt_reversals")) {
      const id = state.reversalIdSeq++;
      const row = {
        id,
        receiving_order_id: params[0],
        receiving_line_id: params[1],
        qty: params[2],
        reason: params[3],
        reversal_scope: params[4],
        order_reversal_id: params[5],
        base_units_reversed: params[6],
        lot_unit_cost_mills: params[7],
        allow_negative: params[8],
        ap_reconciliation_reopened: params[9],
        idempotency_key: params[10],
        created_by: params[11],
      };
      state.insertedReversals.push(row);
      inserts.push({ sqlText: t, params });
      return { rows: [{ id }] };
    }

    // order_reversal_id group update + lot-cost/AP backfill.
    if (t.startsWith("UPDATE procurement.receipt_reversals")) {
      if (t.includes("lot_unit_cost_mills =")) {
        const row = state.insertedReversals.find((r) => r.id === params[params.length - 1]);
        if (row) {
          row.lot_unit_cost_mills = params[0];
          row.ap_reconciliation_reopened = params[1];
        }
      }
      updates.push({ sqlText: t, params });
      return { rows: [] };
    }

    // PO lock + lines for re-evaluation.
    if (t.includes("FROM procurement.purchase_orders") && t.includes("FOR UPDATE")) {
      return { rows: [{ ...po, status: state.poStatus, physical_status: state.poPhysicalStatus }] };
    }
    if (t.includes("FROM procurement.purchase_order_lines") && t.includes("purchase_order_id =")) {
      const poLines = opts.poLines ?? [{
        status: state.poLineStatus,
        line_type: "product",
      }];
      return { rows: poLines.map((l) => ({ status: l.status === "received" && l.id === poLine.id ? state.poLineStatus : l.status, line_type: l.line_type ?? "product" })) };
    }
    if (t.startsWith("UPDATE procurement.purchase_orders")) {
      state.poStatus = params[0];
      state.poPhysicalStatus = params[1];
      updates.push({ sqlText: t, params });
      return { rows: [] };
    }
    if (t.startsWith("INSERT INTO procurement.po_status_history")) {
      state.insertedHistory.push({ params });
      return { rows: [{ id: 1 }] };
    }

    throw new Error(`Unrouted SQL in test harness: ${t.slice(0, 160)}`);
  };

  const db = {
    execute: vi.fn(async (query: any) => route(query)),
    transaction: vi.fn(async (fn: any) => fn({ execute: vi.fn(async (query: any) => route(query)) })),
  } as any;

  return { db, state, service: new ReceiptReversalService(db, inventoryCore as any) };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ReceiptReversalService.reverseReceivingLine", () => {
  it("reverses a partial quantity and decrements PO received_qty by qty × units_per_variant", async () => {
    // Dogfood shape: PO line orderQty 270,000 pieces, UOM 750/case; receipt
    // posted 360 "cases" credited as 360 pieces (variant upv=1 — the bug).
    // Reversing 360 pieces decrements received_qty by 360 × 1.
    const { service, state } = makeHarness({});

    const result = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 200,
      reason: "Partial correction",
      idempotencyKey: "rev-partial-1",
    });

    expect(result.qty).toBe(200);
    expect(result.baseUnitsReversed).toBe(200);
    expect(result.idempotentReplay).toBe(false);
    expect(state.lineReversedQty).toBe(200);
    expect(state.poLineReceivedQty).toBe(160); // 360 - 200
    expect(state.poLineStatus).toBe("partially_received");
    expect(state.lotOnHand[0].qty_on_hand).toBe(160); // 360 - 200
    expect(state.levelQty).toBe(160);
    expect(state.insertedReversals).toHaveLength(1);
    expect(state.insertedTransactions).toHaveLength(1);
    // Ledger audit row goes through the inventory module's public API with
    // the negative qty and the reversal id.
    expect(state.insertedTransactions[0].params.qty).toBe(200);
    expect(state.insertedTransactions[0].params.reversalId).toBe(result.reversalId);
  });

  it("reverses the full remaining quantity", async () => {
    const { service, state } = makeHarness({});

    const result = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 360,
      reason: "Full correction — wrong UOM",
      idempotencyKey: "rev-full-1",
    });

    expect(result.qty).toBe(360);
    expect(state.lineReversedQty).toBe(360);
    expect(state.poLineReceivedQty).toBe(0);
    // Line back to 'open' (nothing received).
    expect(state.poLineStatus).toBe("open");
    expect(state.lotOnHand[0].qty_on_hand).toBe(0);
  });

  it("blocks a double-reverse beyond the remaining reversible qty", async () => {
    const { service, state } = makeHarness({});

    await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 300,
      reason: "First",
      idempotencyKey: "rev-a",
    });
    expect(state.lineReversedQty).toBe(300);

    await expect(
      service.reverseReceivingLine({
        receivingLineId: 1001,
        qty: 100, // only 60 remaining
        reason: "Second — exceeds remaining",
        idempotencyKey: "rev-b",
      }),
    ).rejects.toMatchObject({
      name: "ReceiptReversalError",
      statusCode: 409,
      details: expect.objectContaining({ code: "REVERSAL_QTY_EXCEEDS_REMAINING" }),
    });
  });

  it("blocks when lot on-hand is insufficient (consumed/sold), and allowNegative overrides", async () => {
    const blocked = makeHarness({
      lots: [{ id: 9001, qty_on_hand: 50, unit_cost_mills: 375, warehouse_location_id: 7 }],
      level: { id: 301, variant_qty: 50 },
    });

    await expect(
      blocked.service.reverseReceivingLine({
        receivingLineId: 1001,
        qty: 360,
        reason: "Already sold",
        idempotencyKey: "rev-blocked",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "REVERSAL_INSUFFICIENT_ON_HAND" }),
    });

    const allowed = makeHarness({
      lots: [{ id: 9001, qty_on_hand: 50, unit_cost_mills: 375, warehouse_location_id: 7 }],
      level: { id: 301, variant_qty: 50 },
    });
    const result = await allowed.service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 360,
      reason: "Override — write off shrink",
      idempotencyKey: "rev-override",
      allowNegative: true,
    });
    expect(result.qty).toBe(360);
    expect(allowed.state.insertedReversals[0].allow_negative).toBe(1);
  });

  it("is idempotent: a retry with the same key returns the original reversal without re-applying", async () => {
    const { service, state } = makeHarness({});

    const first = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 100,
      reason: "Original",
      idempotencyKey: "rev-idem",
    });
    expect(first.idempotentReplay).toBe(false);
    expect(state.lineReversedQty).toBe(100);
    expect(state.poLineReceivedQty).toBe(260);

    const replay = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 100,
      reason: "Original",
      idempotencyKey: "rev-idem",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.reversalId).toBe(first.reversalId);
    // No double-apply.
    expect(state.lineReversedQty).toBe(100);
    expect(state.poLineReceivedQty).toBe(260);
    expect(state.insertedReversals).toHaveLength(1);
  });

  it("re-opens AP invoice matching when the PO line was invoice-matched", async () => {
    const { service, state } = makeHarness({
      apMatchedRows: [{ id: 777 }],
    });

    const result = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 10,
      reason: "AP re-open check",
      idempotencyKey: "rev-ap",
    });

    expect(result.apReconciliationReopened).toBe(true);
    expect(state.apReopened).toBe(1);
    expect(state.insertedReversals[0].ap_reconciliation_reopened).toBe(1);
  });

  it("multiplies by live units_per_variant (case variant reverses 360 cases = 270,000 pieces)", async () => {
    // The rebook side of the dogfood case: variant upv=750, PO line received
    // 270,000 pieces; reversing 360 cases decrements 360 × 750 = 270,000.
    const { service, state } = makeHarness({
      variant: { id: 11, units_per_variant: 750 },
      poLine: {
        id: 5001,
        purchase_order_id: 123,
        order_qty: 270000,
        received_qty: 270000,
        damaged_qty: 0,
        cancelled_qty: 0,
        status: "received",
      },
      lots: [{ id: 9001, qty_on_hand: 360, unit_cost_mills: 281250, warehouse_location_id: 7 }],
    });

    const result = await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 360,
      reason: "Rebook correction",
      idempotencyKey: "rev-dogfood",
    });

    expect(result.baseUnitsReversed).toBe(270000);
    expect(state.poLineReceivedQty).toBe(0);
    expect(state.poLineStatus).toBe("open");
  });

  it("re-evaluates the PO header from received → partially_received when a line drops below full", async () => {
    const { service, state } = makeHarness({
      po: { id: 123, status: "received", physical_status: "received" },
      poLine: {
        id: 5001,
        purchase_order_id: 123,
        order_qty: 1000,
        received_qty: 1000,
        status: "received",
      },
      line: { received_qty: 1000 },
      lots: [{ id: 9001, qty_on_hand: 1000, unit_cost_mills: 100, warehouse_location_id: 7 }],
      level: { id: 301, variant_qty: 1000 },
    });

    await service.reverseReceivingLine({
      receivingLineId: 1001,
      qty: 400,
      reason: "Partial unwind",
      idempotencyKey: "rev-po-status",
    });

    expect(state.poLineStatus).toBe("partially_received");
    expect(state.poStatus).toBe("partially_received");
    expect(state.poPhysicalStatus).toBe("receiving");
    expect(state.insertedHistory).toHaveLength(1);
  });

  it("rejects non-closed orders, missing reason, bad qty, and bad ids", async () => {
    const openOrder = makeHarness({ line: { order_status: "open" } });
    await expect(
      openOrder.service.reverseReceivingLine({
        receivingLineId: 1001, qty: 1, reason: "x", idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: "RECEIPT_NOT_CLOSED" }) });

    const { service } = makeHarness({});
    await expect(
      service.reverseReceivingLine({ receivingLineId: 1001, qty: 1, reason: "  ", idempotencyKey: "k2" }),
    ).rejects.toMatchObject({ statusCode: 400, details: expect.objectContaining({ code: "REVERSAL_REASON_REQUIRED" }) });
    await expect(
      service.reverseReceivingLine({ receivingLineId: 1001, qty: 0, reason: "x", idempotencyKey: "k3" }),
    ).rejects.toMatchObject({ statusCode: 400, details: expect.objectContaining({ code: "INVALID_REVERSAL_QTY" }) });
    await expect(
      service.reverseReceivingLine({ receivingLineId: -1, qty: 1, reason: "x", idempotencyKey: "k4" }),
    ).rejects.toMatchObject({ statusCode: 400, details: expect.objectContaining({ code: "INVALID_RECEIVING_LINE_ID" }) });
    await expect(
      service.reverseReceivingLine({ receivingLineId: 1001, qty: 1, reason: "x", idempotencyKey: "" }),
    ).rejects.toMatchObject({ statusCode: 400, details: expect.objectContaining({ code: "INVALID_IDEMPOTENCY_KEY" }) });
  });
});

describe("ReceiptReversalService.reverseReceivingOrder", () => {
  it("reverses every line with remaining reversible qty under one group", async () => {
    const { service, state } = makeHarness({});

    const result = await service.reverseReceivingOrder({
      receivingOrderId: 100,
      reason: "Whole-order correction",
      idempotencyKey: "rev-order-1",
    });

    expect(result.reversals).toHaveLength(1);
    expect(result.reversals[0].qty).toBe(360);
    expect(state.lineReversedQty).toBe(360);
    expect(state.poLineReceivedQty).toBe(0);
    // Group id assigned (first line's reversal id).
    expect(state.insertedReversals[0].reversal_scope).toBe("order");
  });

  it("is idempotent at the order level", async () => {
    const { service, state } = makeHarness({});

    const first = await service.reverseReceivingOrder({
      receivingOrderId: 100,
      reason: "Whole-order correction",
      idempotencyKey: "rev-order-idem",
    });
    expect(first.reversals[0].idempotentReplay).toBe(false);

    const replay = await service.reverseReceivingOrder({
      receivingOrderId: 100,
      reason: "Whole-order correction",
      idempotencyKey: "rev-order-idem",
    });
    expect(replay.reversals[0].idempotentReplay).toBe(true);
    expect(state.insertedReversals).toHaveLength(1);
    expect(state.lineReversedQty).toBe(360);
  });

  it("rejects non-closed orders", async () => {
    const { service } = makeHarness({ order: { status: "open" } });
    await expect(
      service.reverseReceivingOrder({
        receivingOrderId: 100, reason: "x", idempotencyKey: "k",
      }),
    ).rejects.toMatchObject({ statusCode: 409, details: expect.objectContaining({ code: "RECEIPT_NOT_CLOSED" }) });
  });
});

describe("receipt reversal status helpers (pure)", () => {
  const { reevaluatePoLineStatusAfterReversal, reevaluatePoStatusAfterReversal } = __testing__;

  it("line: received → partially_received → open as qty unwinds", () => {
    expect(reevaluatePoLineStatusAfterReversal({
      orderQty: 1000, receivedQty: 1000, cancelledQty: 0, currentStatus: "received",
    })).toBe("received");
    expect(reevaluatePoLineStatusAfterReversal({
      orderQty: 1000, receivedQty: 600, cancelledQty: 0, currentStatus: "received",
    })).toBe("partially_received");
    expect(reevaluatePoLineStatusAfterReversal({
      orderQty: 1000, receivedQty: 0, cancelledQty: 0, currentStatus: "partially_received",
    })).toBe("open");
    // Terminal states never move.
    expect(reevaluatePoLineStatusAfterReversal({
      orderQty: 1000, receivedQty: 0, cancelledQty: 0, currentStatus: "cancelled",
    })).toBe("cancelled");
  });

  it("PO: received → partially_received when not all lines received", () => {
    expect(reevaluatePoStatusAfterReversal({
      poStatus: "received",
      physicalStatus: "received",
      lines: [{ status: "partially_received" }],
    })).toEqual({ legacyStatus: "partially_received", physicalStatus: "receiving" });

    // All still received → no change.
    expect(reevaluatePoStatusAfterReversal({
      poStatus: "received",
      physicalStatus: "received",
      lines: [{ status: "received" }],
    })).toBeNull();

    // Closed POs never move.
    expect(reevaluatePoStatusAfterReversal({
      poStatus: "closed",
      physicalStatus: "received",
      lines: [{ status: "open" }],
    })).toBeNull();

    // Non-product lines are ignored.
    expect(reevaluatePoStatusAfterReversal({
      poStatus: "received",
      physicalStatus: "received",
      lines: [{ status: "received" }, { status: "open", lineType: "discount" }],
    })).toBeNull();
  });
});
