import { describe, expect, it } from "vitest";
import {
  createRecommendationPoHandoffService,
  RecommendationPoHandoffError,
  type AcceptedRecommendationPoHandoffCommand,
  type AutomaticRecommendationPoHandoffCommand,
  type CreatedRecommendationPurchaseOrder,
  type CreatedRecommendationPurchaseOrderLine,
  type RecommendationDecisionRecord,
  type RecommendationAutoDraftRunRecord,
  type RecommendationPoHandoffRecord,
  type RecommendationPoHandoffRepository,
  type RecommendationPoHandoffUnitOfWork,
  type RecommendationProductRecord,
  type RecommendationProductVariantRecord,
  type RecommendationVendorProductRecord,
  type RecommendationVendorRecord,
} from "../../recommendation-po-handoff.service";

const NOW = new Date("2026-07-11T18:00:00.000Z");

interface FakeState {
  autoDraftRuns: RecommendationAutoDraftRunRecord[];
  runCompletions: Array<{ runId: number; values: Record<string, unknown> }>;
  decisions: RecommendationDecisionRecord[];
  handoffs: RecommendationPoHandoffRecord[];
  vendorProducts: RecommendationVendorProductRecord[];
  vendors: RecommendationVendorRecord[];
  products: RecommendationProductRecord[];
  variants: RecommendationProductVariantRecord[];
  pos: CreatedRecommendationPurchaseOrder[];
  lines: CreatedRecommendationPurchaseOrderLine[];
  statusHistory: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
}

function cloneState(state: FakeState): FakeState {
  return {
    autoDraftRuns: state.autoDraftRuns.map((row) => ({ ...row })),
    runCompletions: state.runCompletions.map((row) => ({ runId: row.runId, values: { ...row.values } })),
    decisions: state.decisions.map((row) => ({ ...row })),
    handoffs: state.handoffs.map((row) => ({ ...row })),
    vendorProducts: state.vendorProducts.map((row) => ({ ...row })),
    vendors: state.vendors.map((row) => ({ ...row })),
    products: state.products.map((row) => ({ ...row })),
    variants: state.variants.map((row) => ({ ...row })),
    pos: state.pos.map((row) => ({ ...row, metadata: { ...row.metadata } })),
    lines: state.lines.map((row) => ({ ...row })),
    statusHistory: state.statusHistory.map((row) => ({ ...row })),
    events: state.events.map((row) => ({ ...row })),
  };
}

function acceptedDecision(
  id = 10,
  recommendationId = "101:1001:30",
  kind = "held_by_policy",
  productId = 101,
  productVariantId = 1001,
): RecommendationDecisionRecord {
  return {
    id,
    recommendationId,
    kind,
    decision: "accepted_for_po",
    status: "active",
    decisionReason: "held_by_approval_policy",
    note: null,
    source: "operator",
    autoDraftRunId: null,
    productId,
    productVariantId,
    vendorId: 7,
    sku: "SKU-101",
    productName: "Product 101",
    candidateScore: 88,
    candidateBand: "strong_candidate",
    recommendationSnapshot: {
      item: {
        productId,
        productVariantId,
        preferredVendorId: 7,
        vendorProductId: 701,
        suggestedOrderQty: 300,
        suggestedOrderPieces: 300,
        orderUomUnits: 1,
        estimatedCostMills: 50,
        estimatedCostCents: 1,
        pricingBasis: "per_piece",
        purchaseUom: null,
        quotedUnitCostMills: 50,
        piecesPerPurchaseUom: null,
        quoteReference: "QUOTE-701",
        quotedAt: "2026-07-01T12:00:00.000Z",
        quoteValidUntil: "2026-08-31",
        supplierBasis: { minimumOrderPieces: 1 },
        sku: "SKU-101",
      },
    },
    decidedBy: "reviewer",
    decidedAt: new Date("2026-07-11T17:00:00.000Z"),
    createdAt: new Date("2026-07-11T17:00:00.000Z"),
  };
}

function baseState(): FakeState {
  return {
    autoDraftRuns: [{
      id: 500,
      runAt: new Date("2026-07-11T17:55:00.000Z"),
      status: "running",
      triggeredBy: "scheduler",
      triggeredByUser: null,
    }],
    runCompletions: [],
    decisions: [acceptedDecision()],
    handoffs: [],
    vendorProducts: [{
      id: 701,
      vendorId: 7,
      productId: 101,
      productVariantId: 1001,
      vendorSku: "V-101",
      unitCostCents: 1,
      unitCostMills: 50,
      pricingBasis: "per_piece",
      purchaseUom: null,
      quotedUnitCostMills: 50,
      piecesPerPurchaseUom: null,
      moq: 1,
      quoteReference: "QUOTE-701",
      quotedAt: new Date("2026-07-01T12:00:00.000Z"),
      quotedAtDate: "2026-07-01",
      quoteValidUntil: "2026-08-31",
      updatedAt: new Date("2026-07-01T12:00:00.000Z"),
      isPreferred: 1,
      isActive: 1,
    }],
    vendors: [{
      id: 7,
      active: 1,
      currency: "USD",
      paymentTermsDays: 30,
      paymentTermsType: "net",
      shipFromAddress: "Vendor warehouse",
      defaultIncoterms: "FOB",
    }],
    products: [{
      id: 101,
      sku: "SKU-101",
      name: "Product 101",
      status: "active",
      isActive: true,
    }],
    variants: [{
      id: 1001,
      productId: 101,
      sku: "SKU-101-C100",
      name: "Case of 100",
      unitsPerVariant: 100,
      isActive: true,
    }],
    pos: [],
    lines: [],
    statusHistory: [],
    events: [],
  };
}

function baseCommand(): AcceptedRecommendationPoHandoffCommand {
  return {
    actorId: "admin-user",
    items: [{
      acceptedDecisionId: 10,
      recommendationId: "101:1001:30",
      kind: "held_by_policy",
      productId: 101,
      productVariantId: 1001,
      suggestedPieces: 300,
      orderUomUnits: 1,
      orderUomLabel: "pieces",
      vendorId: 7,
      vendorProductId: 701,
      sku: "SKU-101",
      productName: "Product 101",
      candidateScore: 88,
      candidateBand: "strong_candidate",
      recommendationSnapshot: { lookbackDays: 30, item: { sku: "SKU-101" } },
    }],
  };
}

function automaticCommand(): AutomaticRecommendationPoHandoffCommand {
  return {
    actorId: "system:auto-draft",
    autoDraftRunId: 500,
    items: [{
      recommendationId: "101:1001:30",
      productId: 101,
      productVariantId: 1001,
      suggestedOrderQty: 300,
      suggestedOrderPieces: 300,
      orderUomUnits: 1,
      orderUomLabel: "pieces",
      vendorId: 7,
      vendorProductId: 701,
      sku: "SKU-101",
      productName: "Product 101",
      estimatedCostMills: 50,
      estimatedCostCents: 1,
      pricingBasis: "per_piece",
      purchaseUom: null,
      quotedUnitCostMills: 50,
      piecesPerPurchaseUom: null,
      quoteReference: "QUOTE-701",
      quotedAt: new Date("2026-07-01T12:00:00.000Z"),
      quoteValidUntil: "2026-08-31",
      candidateScore: 88,
      candidateBand: "strong_candidate",
      recommendationSnapshot: {
        item: {
          explanation: "Order three cases.",
          supplierBasis: { minimumOrderPieces: 1 },
        },
      },
    }],
    completion: {
      itemsAnalyzed: 12,
      skippedNoVendor: 2,
      skippedOnOrder: 1,
      skippedExcluded: 3,
      summaryJson: {
        version: 1,
        poMutations: [],
        poMutationSkips: [],
      },
    },
  };
}

function buildHarness(initialState = baseState()) {
  let committed = cloneState(initialState);
  let failOnCreateHandoff = false;
  let failOnCompleteRun = false;
  let transactionCalls = 0;
  const lockCalls: string[][] = [];
  const catalogLockCalls: string[] = [];

  const repository: RecommendationPoHandoffRepository = {
    async transaction<T>(work: (unitOfWork: RecommendationPoHandoffUnitOfWork) => Promise<T>): Promise<T> {
      transactionCalls += 1;
      const staged = cloneState(committed);
      const unitOfWork: RecommendationPoHandoffUnitOfWork = {
        async lockRecommendationKeys(keys) {
          lockCalls.push([...keys]);
        },
        async getTransactionClock() {
          return { timestamp: NOW, date: "2026-07-11" };
        },
        async getAutoDraftRunForUpdate(id) {
          return staged.autoDraftRuns.find((row) => row.id === id) ?? null;
        },
        async completeAutoDraftRun(id, values) {
          if (failOnCompleteRun) return false;
          const run = staged.autoDraftRuns.find((row) => row.id === id && row.status === "running");
          if (!run) return false;
          run.status = "success";
          staged.runCompletions.push({ runId: id, values: { ...values } });
          return true;
        },
        async getDecisionsForUpdate(ids) {
          return staged.decisions.filter((row) => ids.includes(row.id));
        },
        async getLatestActiveDecisions(keys) {
          const requested = new Set(keys.map((key) => JSON.stringify([key.recommendationId, key.kind])));
          return staged.decisions
            .filter((row) => row.status === "active" && requested.has(JSON.stringify([row.recommendationId, row.kind])))
            .sort((left, right) => {
              const timeDelta = right.decidedAt.getTime() - left.decidedAt.getTime();
              return timeDelta || right.id - left.id;
            });
        },
        async getLatestActiveDecisionsByRecommendationIds(recommendationIds) {
          const requested = new Set(recommendationIds);
          return staged.decisions
            .filter((row) => row.status === "active" && requested.has(row.recommendationId))
            .sort((left, right) => {
              const timeDelta = right.decidedAt.getTime() - left.decidedAt.getTime();
              return timeDelta || right.id - left.id;
            });
        },
        async getHandoffsByAcceptedDecisionIds(ids) {
          return staged.handoffs.filter((row) => ids.includes(row.acceptedDecisionId));
        },
        async getVendorProducts(ids) {
          catalogLockCalls.push("vendorProduct");
          return staged.vendorProducts.filter((row) => ids.includes(row.id));
        },
        async getVendors(ids) {
          catalogLockCalls.push("vendor");
          return staged.vendors.filter((row) => ids.includes(row.id));
        },
        async getProducts(ids) {
          catalogLockCalls.push("product");
          return staged.products.filter((row) => ids.includes(row.id));
        },
        async getProductVariants(ids) {
          catalogLockCalls.push("variant");
          return staged.variants.filter((row) => ids.includes(row.id));
        },
        async createPurchaseOrder(values, numberDate) {
          const po: CreatedRecommendationPurchaseOrder = {
            ...values,
            id: staged.pos.length + 100,
            poNumber: `PO-${numberDate.toISOString().slice(0, 10).replace(/-/g, "")}-${String(staged.pos.length + 1).padStart(3, "0")}`,
          };
          staged.pos.push(po);
          return po;
        },
        async createPurchaseOrderLine(values) {
          const line: CreatedRecommendationPurchaseOrderLine = {
            ...values,
            id: staged.lines.length + 1_000,
          };
          staged.lines.push(line);
          return line;
        },
        async createStatusHistory(values) {
          staged.statusHistory.push({ ...values });
        },
        async createPoEvent(values) {
          staged.events.push({ ...values });
        },
        async createDecision(values) {
          const decision: RecommendationDecisionRecord = {
            ...values,
            id: Math.max(0, ...staged.decisions.map((row) => row.id)) + 1,
          };
          staged.decisions.push(decision);
          return decision;
        },
        async createHandoff(values) {
          if (failOnCreateHandoff) throw new Error("forced handoff insert failure");
          const handoff: RecommendationPoHandoffRecord = {
            ...values,
            id: staged.handoffs.length + 1,
          };
          staged.handoffs.push(handoff);
          return handoff;
        },
      };

      const result = await work(unitOfWork);
      committed = staged;
      return result;
    },
  };

  return {
    repository,
    lockCalls,
    catalogLockCalls,
    get transactionCalls() {
      return transactionCalls;
    },
    get state() {
      return committed;
    },
    failHandoffInsert() {
      failOnCreateHandoff = true;
    },
    failRunCompletion() {
      failOnCompleteRun = true;
    },
  };
}

describe("recommendation PO handoff service", () => {
  it("creates the PO, exact receive line, audit decision, and mapping in mills", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAcceptedHandoff(baseCommand());

    expect(result.pos).toHaveLength(1);
    expect(result.pos[0]).toMatchObject({
      poNumber: "PO-20260711-001",
      vendorId: 7,
      subtotalCents: 150,
      totalCents: 150,
      lineCount: 1,
      source: "reorder",
    });
    expect(harness.state.lines).toEqual([
      expect.objectContaining({
        purchaseOrderId: result.pos[0].id,
        productId: 101,
        productVariantId: 1001,
        expectedReceiveVariantId: 1001,
        expectedReceiveUnitsPerVariant: 100,
        orderQty: 300,
        unitCostMills: 50,
        unitCostCents: 1,
        totalProductCostCents: 150,
        lineTotalCents: 150,
        pricingBasis: "per_piece",
        quotedUnitCostMills: 50,
        quoteReference: "QUOTE-701",
        quotedAt: new Date("2026-07-01T12:00:00.000Z"),
        quoteValidUntil: "2026-08-31",
      }),
    ]);
    expect(harness.state.statusHistory).toHaveLength(1);
    expect(harness.state.events).toEqual([
      expect.objectContaining({
        eventType: "created",
        payloadJson: expect.objectContaining({ subtotal_cents: 150 }),
      }),
    ]);
    expect(result.handedOff).toEqual([
      expect.objectContaining({
        acceptedDecisionId: 10,
        handoffDecisionId: 11,
        poId: result.pos[0].id,
        poLineId: harness.state.lines[0].id,
        poIds: [result.pos[0].id],
      }),
    ]);
    expect(harness.state.handoffs).toEqual([
      expect.objectContaining({
        acceptedDecisionId: 10,
        handoffDecisionId: 11,
        purchaseOrderId: result.pos[0].id,
        purchaseOrderLineId: harness.state.lines[0].id,
      }),
    ]);
    expect(result.decisions[0].recommendationSnapshot).toMatchObject({
      poHandoff: {
        acceptedDecisionId: 10,
        poId: result.pos[0].id,
        poLineId: harness.state.lines[0].id,
        poNumber: "PO-20260711-001",
      },
    });
    expect(harness.lockCalls).toEqual([[
      JSON.stringify(["101:1001:30", "held_by_policy"]),
      JSON.stringify(["101:1001:30", "po_mutation"]),
    ]]);
    expect(harness.catalogLockCalls).toEqual(["vendor", "product", "variant", "vendorProduct"]);
  });

  it("preserves a per-purchase-UOM quote and derives its exact UOM quantity", async () => {
    const state = baseState();
    const snapshotItem = (state.decisions[0].recommendationSnapshot as any).item;
    Object.assign(snapshotItem, {
      estimatedCostMills: 125,
      estimatedCostCents: 1,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      quotedUnitCostMills: 12_500,
      piecesPerPurchaseUom: 100,
    });
    Object.assign(state.vendorProducts[0], {
      unitCostMills: 125,
      unitCostCents: 1,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      quotedUnitCostMills: 12_500,
      piecesPerPurchaseUom: 100,
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAcceptedHandoff(baseCommand());

    expect(result.pos[0]).toMatchObject({ subtotalCents: 375, totalCents: 375 });
    expect(harness.state.lines[0]).toMatchObject({
      orderQty: 300,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      purchaseUomQuantity: 3,
      piecesPerPurchaseUom: 100,
      quotedUnitCostMills: 12_500,
      unitCostMills: 125,
      totalProductCostCents: 375,
      lineTotalCents: 375,
    });
  });

  it("keeps the supplier purchase UOM independent from warehouse receive-pack units", async () => {
    const state = baseState();
    const snapshotItem = (state.decisions[0].recommendationSnapshot as any).item;
    Object.assign(snapshotItem, {
      suggestedOrderQty: 6,
      suggestedOrderPieces: 36,
      orderUomUnits: 6,
      estimatedCostMills: 50,
      estimatedCostCents: 1,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "pack",
      quotedUnitCostMills: 300,
      piecesPerPurchaseUom: 6,
      supplierBasis: { minimumOrderPieces: 31 },
    });
    Object.assign(state.vendorProducts[0], {
      unitCostMills: 50,
      unitCostCents: 1,
      pricingBasis: "per_purchase_uom",
      purchaseUom: "pack",
      quotedUnitCostMills: 300,
      piecesPerPurchaseUom: 6,
      moq: 31,
    });
    const command = baseCommand();
    Object.assign(command.items[0], {
      suggestedPieces: 36,
      orderUomUnits: 6,
      orderUomLabel: "pack",
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAcceptedHandoff(command);

    expect(result.pos[0]).toMatchObject({ subtotalCents: 18, totalCents: 18 });
    expect(harness.state.lines[0]).toMatchObject({
      orderQty: 36,
      expectedReceiveVariantId: 1001,
      expectedReceiveUnitsPerVariant: 100,
      purchaseUom: "pack",
      purchaseUomQuantity: 6,
      piecesPerPurchaseUom: 6,
      totalProductCostCents: 18,
    });
  });

  it("creates an automatic PO from a current zero-dollar supplier quote", async () => {
    const state = baseState();
    Object.assign(state.vendorProducts[0], {
      unitCostMills: 0,
      unitCostCents: 0,
      quotedUnitCostMills: 0,
    });
    const command = automaticCommand();
    Object.assign(command.items[0], {
      estimatedCostMills: 0,
      estimatedCostCents: 0,
      quotedUnitCostMills: 0,
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAutomaticHandoff(command);

    expect(result.pos[0]).toMatchObject({ subtotalCents: 0, totalCents: 0 });
    expect(harness.state.lines[0]).toMatchObject({
      unitCostMills: 0,
      unitCostCents: 0,
      quotedUnitCostMills: 0,
      totalProductCostCents: 0,
      lineTotalCents: 0,
    });
  });

  it("blocks legacy catalog pricing until its quote basis is confirmed", async () => {
    const state = baseState();
    state.vendorProducts[0] = {
      ...state.vendorProducts[0],
      pricingBasis: "legacy_unknown",
      purchaseUom: null,
      quotedUnitCostMills: null,
      piecesPerPurchaseUom: null,
    };
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_QUOTE_BASIS_REVIEW_REQUIRED",
      context: { vendorProductId: 701, pricingBasis: "legacy_unknown" },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rejects non-USD recommendation handoff before creating a PO", async () => {
    const state = baseState();
    state.vendors[0].currency = "EUR";
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 422,
      code: "PO_FX_RATE_REQUIRED",
      context: {
        vendorId: 7,
        currency: "EUR",
        reportingCurrency: "USD",
      },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rejects a changed quote basis even when normalized per-piece mills are unchanged", async () => {
    const state = baseState();
    Object.assign(state.vendorProducts[0], {
      pricingBasis: "per_purchase_uom",
      purchaseUom: "pack",
      quotedUnitCostMills: 500,
      piecesPerPurchaseUom: 10,
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_QUOTE_CHANGED",
      context: { vendorProductId: 701, field: "pricingBasis" },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rejects a locked catalog MOQ change instead of silently increasing the accepted quantity", async () => {
    const state = baseState();
    state.vendorProducts[0].moq = 400;
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_MOQ_CHANGED",
      context: {
        vendorProductId: 701,
        acceptedMinimumOrderPieces: 1,
        currentMinimumOrderPieces: 400,
      },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
  });

  it("rejects an invalid locked catalog MOQ before PO creation", async () => {
    const state = baseState();
    state.vendorProducts[0].moq = 0;
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_MOQ_INVALID",
      context: { vendorProductId: 701, minimumOrderPieces: 0 },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rejects PostgreSQL INTEGER overflow before opening an accepted-handoff transaction", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);
    const command = baseCommand();
    command.items[0].suggestedPieces = 2_147_483_648;

    await expect(service.createAcceptedHandoff(command)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_RECOMMENDATION_HANDOFF",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.transactionCalls).toBe(0);
    expect(harness.lockCalls).toHaveLength(0);
  });

  it("rejects PostgreSQL INTEGER overflow in automatic quantities and run counters before DB access", async () => {
    const quantityHarness = buildHarness();
    const quantityService = createRecommendationPoHandoffService(quantityHarness.repository);
    const quantityCommand = automaticCommand();
    quantityCommand.items[0].suggestedOrderQty = 2_147_483_648;

    await expect(quantityService.createAutomaticHandoff(quantityCommand)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_AUTOMATIC_RECOMMENDATION_HANDOFF",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(quantityHarness.transactionCalls).toBe(0);

    const counterHarness = buildHarness();
    const counterService = createRecommendationPoHandoffService(counterHarness.repository);
    const counterCommand = automaticCommand();
    counterCommand.completion.itemsAnalyzed = 2_147_483_648;
    await expect(counterService.createAutomaticHandoff(counterCommand)).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_AUTOMATIC_RECOMMENDATION_HANDOFF",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(counterHarness.transactionCalls).toBe(0);
  });

  it("creates one independent draft PO per vendor with exact line mappings", async () => {
    const state = baseState();
    const secondDecision = acceptedDecision(20, "202:2002:30", "quality_review_required", 202, 2002);
    secondDecision.vendorId = 8;
    secondDecision.recommendationSnapshot = {
      item: {
        productId: 202,
        productVariantId: 2002,
        preferredVendorId: 8,
        vendorProductId: 802,
        suggestedOrderQty: 2,
        suggestedOrderPieces: 20,
        orderUomUnits: 10,
        estimatedCostMills: 125,
        estimatedCostCents: 1,
        pricingBasis: "per_piece",
        purchaseUom: null,
        quotedUnitCostMills: 125,
        piecesPerPurchaseUom: null,
        quoteReference: "QUOTE-802",
        quotedAt: "2026-07-02T12:00:00.000Z",
        quoteValidUntil: "2026-08-31",
        supplierBasis: { minimumOrderPieces: 1 },
      },
    };
    state.decisions.push(secondDecision);
    state.vendorProducts.push({
      id: 802,
      vendorId: 8,
      productId: 202,
      productVariantId: 2002,
      vendorSku: "V-202",
      unitCostCents: 1,
      unitCostMills: 125,
      pricingBasis: "per_piece",
      purchaseUom: null,
      quotedUnitCostMills: 125,
      piecesPerPurchaseUom: null,
      moq: 1,
      quoteReference: "QUOTE-802",
      quotedAt: new Date("2026-07-02T12:00:00.000Z"),
      quotedAtDate: "2026-07-02",
      quoteValidUntil: "2026-08-31",
      updatedAt: new Date("2026-07-02T12:00:00.000Z"),
      isPreferred: 1,
      isActive: 1,
    });
    state.vendors.push({
      id: 8,
      active: 1,
      currency: "USD",
      paymentTermsDays: 15,
      paymentTermsType: "net",
      shipFromAddress: null,
      defaultIncoterms: null,
    });
    state.products.push({ id: 202, sku: "SKU-202", name: "Product 202", status: "active", isActive: true });
    state.variants.push({
      id: 2002,
      productId: 202,
      sku: "SKU-202-B10",
      name: "Box of 10",
      unitsPerVariant: 10,
      isActive: true,
    });
    const command = baseCommand();
    command.items.push({
      acceptedDecisionId: 20,
      recommendationId: "202:2002:30",
      kind: "quality_review_required",
      productId: 202,
      productVariantId: 2002,
      suggestedPieces: 20,
      orderUomUnits: 10,
      orderUomLabel: "Box",
      vendorId: 8,
      vendorProductId: 802,
      sku: "SKU-202",
      productName: "Product 202",
      candidateScore: 70,
      candidateBand: "review_candidate",
      recommendationSnapshot: { item: { sku: "SKU-202" } },
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAcceptedHandoff(command);

    expect(result.pos.map((po) => po.vendorId)).toEqual([7, 8]);
    expect(result.pos.map((po) => po.poNumber)).toEqual(["PO-20260711-001", "PO-20260711-002"]);
    expect(harness.state.lines).toHaveLength(2);
    expect(result.handedOff).toEqual([
      expect.objectContaining({ acceptedDecisionId: 10, poId: result.pos[0].id, poLineId: 1_000 }),
      expect.objectContaining({ acceptedDecisionId: 20, poId: result.pos[1].id, poLineId: 1_001 }),
    ]);
  });

  it("requires a new acceptance when the requested quantity drifts from the accepted basis", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);
    const command = baseCommand();
    command.items[0].suggestedPieces = 400;

    await expect(service.createAcceptedHandoff(command)).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCEPTED_RECOMMENDATION_ECONOMICS_CHANGED",
      context: { field: "suggestedOrderPieces", accepted: 300, requested: 400 },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("requires a new acceptance when the live supplier cost differs from the accepted cost", async () => {
    const state = baseState();
    state.vendorProducts[0].unitCostMills = 75;
    state.vendorProducts[0].unitCostCents = 1;
    state.vendorProducts[0].quotedUnitCostMills = 75;
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_QUOTE_CHANGED",
      context: { field: "quotedUnitCostMills", accepted: 50, current: 75 },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("requires a new acceptance when immutable quote metadata changes", async () => {
    const state = baseState();
    state.vendorProducts[0].quoteReference = "QUOTE-701-REV-2";
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "RECOMMENDATION_VENDOR_QUOTE_CHANGED",
      context: {
        vendorProductId: 701,
        field: "quoteReference",
        accepted: "QUOTE-701",
        current: "QUOTE-701-REV-2",
      },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it.each([
    {
      label: "expired",
      quotedAt: new Date("2026-07-01T12:00:00.000Z"),
      quotedAtDate: "2026-07-01",
      quoteValidUntil: "2026-07-10",
      code: "RECOMMENDATION_VENDOR_QUOTE_EXPIRED",
    },
    {
      label: "older than the automation maximum",
      quotedAt: new Date("2025-07-10T17:59:59.000Z"),
      quotedAtDate: "2025-07-10",
      quoteValidUntil: null,
      code: "RECOMMENDATION_VENDOR_QUOTE_STALE",
    },
    {
      label: "future-dated beyond clock skew",
      quotedAt: new Date("2026-07-11T18:05:00.001Z"),
      quotedAtDate: "2026-07-11",
      quoteValidUntil: "2026-08-31",
      code: "RECOMMENDATION_VENDOR_QUOTE_FUTURE_DATED",
    },
  ])("rejects a locked $label quote at handoff transaction time", async ({
    quotedAt,
    quotedAtDate,
    quoteValidUntil,
    code,
  }) => {
    const state = baseState();
    const snapshotItem = (state.decisions[0].recommendationSnapshot as any).item;
    Object.assign(snapshotItem, {
      quotedAt: quotedAt.toISOString(),
      quoteValidUntil,
    });
    Object.assign(state.vendorProducts[0], { quotedAt, quotedAtDate, quoteValidUntil });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code,
      context: {
        vendorProductId: 701,
        transactionTimestamp: NOW.toISOString(),
        transactionDate: "2026-07-11",
      },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
  });

  it("rejects an accepted decision that already has a PO-line handoff", async () => {
    const state = baseState();
    state.handoffs.push({
      id: 1,
      acceptedDecisionId: 10,
      handoffDecisionId: 11,
      purchaseOrderId: 99,
      purchaseOrderLineId: 999,
      recommendationId: "101:1001:30",
      kind: "held_by_policy",
      createdBy: "admin-user",
      createdAt: NOW,
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCEPTED_RECOMMENDATION_ALREADY_HANDED_OFF",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
  });

  it("rejects an acceptance when a newer active decision exists", async () => {
    const state = baseState();
    state.decisions.push({
      ...acceptedDecision(11),
      decision: "deferred",
      decidedAt: new Date("2026-07-11T17:30:00.000Z"),
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCEPTED_RECOMMENDATION_DECISION_STALE",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rejects an operator handoff when another recommendation path created newer supply", async () => {
    const state = baseState();
    state.decisions.push({
      ...acceptedDecision(11, "101:1001:30", "auto_draft_eligible"),
      decision: "po_handoff_created",
      source: "auto_draft",
      autoDraftRunId: 500,
      decidedAt: new Date("2026-07-11T17:30:00.000Z"),
      createdAt: new Date("2026-07-11T17:30:00.000Z"),
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCEPTED_RECOMMENDATION_CROSS_KIND_STALE",
      context: {
        acceptedDecisionId: 10,
        latestDecisionId: 11,
        latestKind: "auto_draft_eligible",
      },
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.state.pos).toHaveLength(0);
  });

  it("rolls back the PO, line, audit event, and handoff decision when mapping fails", async () => {
    const harness = buildHarness();
    harness.failHandoffInsert();
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAcceptedHandoff(baseCommand())).rejects.toThrow("forced handoff insert failure");

    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
    expect(harness.state.handoffs).toHaveLength(0);
    expect(harness.state.statusHistory).toHaveLength(0);
    expect(harness.state.events).toHaveLength(0);
    expect(harness.state.decisions).toHaveLength(1);
  });

  it("creates automatic acceptance, PO, handoff decision, and run provenance atomically", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAutomaticHandoff(automaticCommand());

    expect(result.skipped).toEqual([]);
    expect(result.pos).toEqual([
      expect.objectContaining({
        vendorId: 7,
        source: "auto_draft",
        autoDraftDate: "2026-07-11",
        subtotalCents: 150,
        totalCents: 150,
        metadata: expect.objectContaining({
          source: "automatic_recommendation_handoff",
          autoDraftRunId: 500,
        }),
      }),
    ]);
    expect(harness.state.decisions.slice(-2)).toEqual([
      expect.objectContaining({
        id: 11,
        kind: "auto_draft_eligible",
        decision: "accepted_for_po",
        source: "auto_draft",
        autoDraftRunId: 500,
        decisionReason: "auto_draft_policy_approved",
      }),
      expect.objectContaining({
        id: 12,
        kind: "auto_draft_eligible",
        decision: "po_handoff_created",
        source: "auto_draft",
        autoDraftRunId: 500,
        decisionReason: "automatic_recommendation_po_handoff",
      }),
    ]);
    expect((harness.state.decisions.at(-2)?.recommendationSnapshot as any).item.supplierBasis).toMatchObject({
      minimumOrderPieces: 1,
    });
    expect(harness.state.handoffs).toEqual([
      expect.objectContaining({
        acceptedDecisionId: 11,
        handoffDecisionId: 12,
        recommendationId: "101:1001:30",
        kind: "auto_draft_eligible",
      }),
    ]);
    expect(harness.lockCalls).toEqual([[
      JSON.stringify(["101:1001:30", "auto_draft_eligible"]),
      JSON.stringify(["101:1001:30", "po_mutation"]),
    ]]);
    expect(harness.state.runCompletions).toEqual([
      {
        runId: 500,
        values: expect.objectContaining({
          status: "success",
          itemsAnalyzed: 12,
          posCreated: 1,
          posUpdated: 0,
          linesAdded: 1,
          skippedNoVendor: 2,
          skippedOnOrder: 1,
          skippedExcluded: 3,
          summaryJson: expect.objectContaining({
            poMutations: [{ vendorId: 7, poId: 100, action: "created", linesAdded: 1 }],
            poMutationSkips: [],
          }),
          finishedAt: NOW,
          leaseExpiresAt: null,
        }),
      },
    ]);
  });

  it("skips an automatic snapshot when another review path commits after its run started", async () => {
    const state = baseState();
    state.decisions.push({
      ...acceptedDecision(11, "101:1001:30", "held_by_policy"),
      decision: "po_handoff_created",
      source: "auto_draft",
      autoDraftRunId: 499,
      decidedAt: new Date("2026-07-11T17:56:00.000Z"),
      createdAt: new Date("2026-07-11T17:56:00.000Z"),
    });
    const harness = buildHarness(state);
    const service = createRecommendationPoHandoffService(harness.repository);

    const result = await service.createAutomaticHandoff(automaticCommand());

    expect(result).toMatchObject({
      pos: [],
      decisions: [],
      handedOff: [],
      skipped: [{
        recommendationId: "101:1001:30",
        kind: "auto_draft_eligible",
        reason: "changed_after_run_started",
        latestDecisionId: 11,
      }],
    });
    expect(harness.state.decisions).toHaveLength(2);
    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.runCompletions).toEqual([
      expect.objectContaining({
        runId: 500,
        values: expect.objectContaining({
          status: "success",
          posCreated: 0,
          linesAdded: 0,
          summaryJson: expect.objectContaining({
            poMutationSkips: [expect.objectContaining({ latestDecisionId: 11 })],
          }),
        }),
      }),
    ]);
  });

  it("rolls back the automatic acceptance when its immutable mapping fails", async () => {
    const harness = buildHarness();
    harness.failHandoffInsert();
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAutomaticHandoff(automaticCommand())).rejects.toThrow(
      "forced handoff insert failure",
    );

    expect(harness.state.decisions).toHaveLength(1);
    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
    expect(harness.state.handoffs).toHaveLength(0);
    expect(harness.state.runCompletions).toHaveLength(0);
  });

  it("rolls back automatic PO writes when the run cannot transition to success", async () => {
    const harness = buildHarness();
    harness.failRunCompletion();
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.createAutomaticHandoff(automaticCommand())).rejects.toMatchObject({
      statusCode: 409,
      code: "AUTO_DRAFT_RUN_COMPLETION_CONFLICT",
      context: { autoDraftRunId: 500 },
    } satisfies Partial<RecommendationPoHandoffError>);

    expect(harness.state.pos).toHaveLength(0);
    expect(harness.state.lines).toHaveLength(0);
    expect(harness.state.handoffs).toHaveLength(0);
    expect(harness.state.decisions).toHaveLength(1);
    expect(harness.state.runCompletions).toHaveLength(0);
  });

  it("records operator decisions through the same recommendation lock and transaction", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);

    const created = await service.recordDecision({
      recommendationId: "101:1001:30",
      kind: "held_by_policy",
      decision: "deferred",
      status: "active",
      decisionReason: "operator_review",
      note: "Wait for the revised forecast.",
      source: "operator",
      productId: 101,
      productVariantId: 1001,
      vendorId: 7,
      sku: "SKU-101",
      productName: "Product 101",
      candidateScore: 88,
      candidateBand: "strong_candidate",
      recommendationSnapshot: { item: { sku: "SKU-101" } },
      decidedBy: "admin-user",
    });

    expect(created).toMatchObject({ id: 11, decision: "deferred", decidedAt: NOW, createdAt: NOW });
    expect(harness.state.decisions).toHaveLength(2);
    expect(harness.lockCalls).toEqual([[
      JSON.stringify(["101:1001:30", "held_by_policy"]),
      JSON.stringify(["101:1001:30", "po_mutation"]),
    ]]);
  });

  it("rejects acceptance before writing when its economic basis is incomplete", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);

    await expect(service.recordDecision({
      recommendationId: "101:1001:30",
      kind: "held_by_policy",
      decision: "accepted_for_po",
      status: "active",
      decisionReason: "operator_review",
      note: null,
      source: "operator",
      productId: 101,
      productVariantId: 1001,
      vendorId: 7,
      sku: "SKU-101",
      productName: "Product 101",
      candidateScore: 88,
      candidateBand: "strong_candidate",
      recommendationSnapshot: { item: { productId: 101 } },
      decidedBy: "admin-user",
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCEPTED_RECOMMENDATION_ECONOMIC_BASIS_MISSING",
    } satisfies Partial<RecommendationPoHandoffError>);
    expect(harness.lockCalls).toHaveLength(0);
    expect(harness.state.decisions).toHaveLength(1);
  });

  it("records system audit identity without writing a nonexistent user foreign key", async () => {
    const harness = buildHarness();
    const service = createRecommendationPoHandoffService(harness.repository);
    const command = baseCommand();
    command.actorId = "SYSTEM";

    await service.createAcceptedHandoff(command);

    expect(harness.state.pos[0]).toMatchObject({ createdBy: null, updatedBy: null });
    expect(harness.state.statusHistory[0]).toMatchObject({ changedBy: null });
    expect(harness.state.events[0]).toMatchObject({ actorType: "system", actorId: "system:auto" });
    expect(harness.state.handoffs[0]).toMatchObject({ createdBy: null });
    expect(harness.state.decisions[harness.state.decisions.length - 1]).toMatchObject({ decidedBy: "SYSTEM" });
  });
});
