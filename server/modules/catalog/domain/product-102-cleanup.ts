import { z } from "zod";

import {
  PRODUCT_102_COUNT_IDS,
  PRODUCT_102_UNRELATED_ORDER_IDS,
  cleanupRequire,
} from "@shared/catalog/product-102-cleanup-contract";
export * from "@shared/catalog/product-102-cleanup-contract";
export interface CleanupReference {
  parent: string;
  id: number;
  schema: string;
  table: string;
  column: string;
  constraint: string;
  definition: string;
  count: string;
}
export interface CleanupSnapshot {
  data: string;
  manifest: string;
  schemaReady: boolean;
  references: CleanupReference[];
  guardProblems: string[];
}
const rows = (value: unknown) => z.array(z.record(z.unknown())).parse(value);
function exactlyIds(value: unknown, expected: readonly number[]): void {
  const actual = rows(value)
    .map((row) => z.number().int().positive().parse(row.id))
    .sort((a, b) => a - b);
  cleanupRequire(
    JSON.stringify(actual) === JSON.stringify(expected),
    "CLEANUP_SCOPE_CHANGED",
    "An exact record list changed.",
  );
}

export function assertProduct102CleanupEligible(
  snapshot: CleanupSnapshot,
): void {
  cleanupRequire(
    snapshot.schemaReady,
    "CLEANUP_MIGRATION_REQUIRED",
    "Deploy migration 0695 before obtaining an executable preview.",
  );
  cleanupRequire(
    snapshot.guardProblems.length === 0,
    "CLEANUP_GUARD_MISSING",
    snapshot.guardProblems.join("; "),
  );
  assertProduct102ReviewedRows(snapshot);
  assertCleanupReferenceScope(snapshot.references, false);
}

/** Read-only preflight also runs this before the history migration exists. */
export function assertProduct102ReviewedRows(snapshot: CleanupSnapshot): void {
  const state = z.record(z.unknown()).parse(JSON.parse(snapshot.data));
  z.object({
    id: z.literal(102),
    sku: z.literal("ZZ-DUPE-SHLZ-TOP-35PT-BLU"),
    is_active: z.literal(false),
    status: z.literal("archived"),
  }).parse(state.sourceProduct);
  const products = rows(state.products),
    variants = rows(state.variants),
    lines = rows(state.poLines);
  z.object({
    id: z.literal(5),
    sku: z.literal("SHLZ-TOP-35PT-BLU"),
    is_active: z.literal(true),
  }).parse(products.find((row) => row.id === 5));
  z.object({
    id: z.literal(206),
    product_id: z.literal(5),
    sku: z.literal("SHLZ-TOP-35PT-BLU-C1000"),
    units_per_variant: z.literal(1000),
    is_active: z.literal(true),
  }).parse(variants.find((row) => row.id === 206));
  z.object({
    id: z.literal(102),
    product_id: z.literal(50),
    sku: z.literal("GLV-GRD-SGC-VNT-C10000"),
  }).parse(variants.find((row) => row.id === 102));
  cleanupRequire(
    !variants.some((row) => row.product_id === 102),
    "CLEANUP_SOURCE_HAS_VARIANTS",
    "Source product gained a variant.",
  );
  for (const [id, po, status, quantity, cancelled, mapping] of [
    [39, 7, "cancelled", 400000, 400000, null],
    [221, 134, "open", 352000, 0, 25],
  ] as const) {
    z.object({
      id: z.literal(id),
      purchase_order_id: z.literal(po),
      product_id: z.literal(102),
      vendor_product_id: z.literal(mapping),
      product_variant_id: z.literal(206),
      expected_receive_variant_id: z.literal(206),
      expected_receive_units_per_variant: z.literal(1),
      status: z.literal(status),
      line_type: z.literal("product"),
      order_qty: z.literal(quantity),
      received_qty: z.literal(0),
      cancelled_qty: z.literal(cancelled),
      damaged_qty: z.literal(0),
      returned_qty: z.literal(0),
    }).parse(lines.find((row) => row.id === id));
    z.object({ id: z.literal(po), vendor_id: z.literal(2) }).parse(
      rows(state.poHeaders).find((row) => row.id === po),
    );
  }
  for (const [id, productId] of [
    [25, 102],
    [125, 5],
  ] as const) {
    z.object({
      id: z.literal(id),
      product_id: z.literal(productId),
      vendor_id: z.literal(2),
      product_variant_id: z.literal(206),
      is_active: z.literal(1),
    }).parse(rows(state.suppliers).find((row) => row.id === id));
  }
  // PO 7 is cancelled, but its historical invoice is paid. The PO line is not
  // deleted and this link, the invoice amounts and its status stay unchanged.
  exactlyIds(state.invoiceLines, [43]);
  z.object({
    id: z.literal(43),
    vendor_invoice_id: z.literal(9),
    purchase_order_line_id: z.literal(39),
    product_variant_id: z.literal(206),
    sku: z.literal("SHLZ-TOP-35PT-BLU-C1000"),
  }).parse(rows(state.invoiceLines)[0]);
  exactlyIds(state.invoices, [9]);
  z.object({
    id: z.literal(9),
    vendor_id: z.literal(2),
    status: z.literal("paid"),
  }).parse(rows(state.invoices)[0]);
  exactlyIds(state.counts, PRODUCT_102_COUNT_IDS);
  for (const count of rows(state.counts))
    z.object({
      product_id: z.literal(102),
      product_variant_id: z.literal(206),
      expected_sku: z.literal("SHLZ-TOP-35PT-BLU-C1000"),
      counted_sku: z.literal("SHLZ-TOP-35PT-BLU-C1000"),
      expected_qty: z.literal(80),
      counted_qty: z.literal(80),
      variance_qty: z.literal(0),
      status: z.literal("counted"),
      adjustment_transaction_id: z.null(),
      related_item_id: z.null(),
    }).parse(count);
  exactlyIds(state.orderItems, PRODUCT_102_UNRELATED_ORDER_IDS);
  for (const row of rows(state.orderItems))
    z.object({
      product_id: z.literal(102),
      sku: z.literal("GLV-GRD-SGC-VNT-C10000"),
    }).parse(row);
  for (const [id, productId] of [
    [71, 102],
    [105, 5],
  ] as const)
    z.object({
      id: z.literal(id),
      product_id: z.literal(productId),
      product_line_id: z.literal(1),
    }).parse(rows(state.memberships).find((row) => row.id === id));
  const observations = rows(state.observations),
    source = observations.filter((row) => row.product_id === 102);
  cleanupRequire(
    source.length === 38,
    "CLEANUP_FORECAST_SCOPE_CHANGED",
    "Expected the 38 reviewed source observations.",
  );
  for (const observation of source) {
    z.object({
      selected_receive_variant_id: z.null(),
      forecast_daily_pieces_micros: z.literal(0),
      baseline_daily_pieces_micros: z.literal(0),
      forward_demand_pieces: z.literal(0),
      forward_demand_raw_pieces: z.literal(0),
    }).parse(observation);
    cleanupRequire(
      observations.some(
        (row) =>
          row.product_id === 5 &&
          row.run_id === observation.run_id &&
          row.scope === observation.scope,
      ),
      "CLEANUP_FORECAST_SCOPE_CHANGED",
      "The matching target forecast is missing.",
    );
  }
  cleanupRequire(
    !rows(state.contributions).some((row) =>
      source.some((observation) => observation.id === row.observation_id),
    ),
    "CLEANUP_FORECAST_SCOPE_CHANGED",
    "Source forecast gained an overlay contribution.",
  );
  cleanupRequire(
    rows(state.evaluations).filter((row) =>
      source.some((observation) => observation.id === row.observation_id),
    ).length === 66,
    "CLEANUP_EVALUATION_SCOPE_CHANGED",
    "The 66 reviewed source evaluations changed; review the new evidence before proceeding.",
  );
  z.object({
    authority: z.literal("legacy"),
    activation_run_id: z.null(),
  }).parse(state.authority);
  cleanupRequire(
    rows(state.freezes).length === 0 && rows(state.openings).length === 0,
    "CLEANUP_CUTOVER_ACTIVE",
    "A freeze or ledger opening blocks cleanup.",
  );
  z.object({
    epoch: z.union([
      z.number().int().positive(),
      z.string().regex(/^[1-9][0-9]*$/),
    ]),
  }).parse(state.fence);
}

export function assertCleanupReferenceScope(
  references: CleanupReference[],
  after: boolean,
  historyInstalled = true,
): void {
  const required: [string, number, string][] = [
    ["catalog.products", 102, "inventory.cycle_count_items.product_id"],
    ["catalog.products", 102, "procurement.purchase_order_lines.product_id"],
    ["catalog.products", 102, "procurement.vendor_products.product_id"],
    ["catalog.products", 102, "catalog.product_line_products.product_id"],
    [
      "procurement.vendor_products",
      25,
      "procurement.purchase_order_lines.vendor_product_id",
    ],
    [
      "procurement.purchase_order_lines",
      39,
      "procurement.vendor_invoice_lines.purchase_order_line_id",
    ],
  ];
  for (const [parent, id, child] of required)
    cleanupRequire(
      references.some(
        (reference) =>
          reference.parent === parent &&
          reference.id === id &&
          `${reference.schema}.${reference.table}.${reference.column}` ===
            child,
      ),
      "CLEANUP_REFERENCE_GUARD_MISSING",
      `Required foreign key is missing: ${parent}:${id} -> ${child}.`,
    );
  for (const id of [39, 221])
    cleanupRequire(
      references.some(
        (reference) =>
          reference.parent === "procurement.purchase_order_lines" &&
          reference.id === id,
      ),
      "CLEANUP_REFERENCE_GUARD_MISSING",
      `PO line ${id} incoming references were not inspected.`,
    );
  for (const reference of references) {
    const child = `${reference.schema}.${reference.table}.${reference.column}`;
    const preservedInvoice =
      reference.parent === "procurement.purchase_order_lines" &&
      reference.id === 39 &&
      child === "procurement.vendor_invoice_lines.purchase_order_line_id";
    const expected = preservedInvoice
      ? "1"
      : after
        ? "0"
        : reference.parent === "catalog.products"
          ? ((
              {
                "inventory.cycle_count_items.product_id": "10",
                "procurement.purchase_order_lines.product_id": "2",
                "procurement.vendor_products.product_id": "1",
                "catalog.product_line_products.product_id": "1",
                ...(!historyInstalled
                  ? {
                      "procurement.purchase_forecast_observations.product_id":
                        "38",
                    }
                  : {}),
              } as Record<string, string>
            )[child] ?? "0")
          : reference.parent === "procurement.vendor_products" &&
              child === "procurement.purchase_order_lines.vendor_product_id"
            ? "1"
            : "0";
    cleanupRequire(
      reference.count === expected,
      "CLEANUP_DEPENDENCY_CHANGED",
      `Unexpected dependency ${reference.parent}:${reference.id} -> ${child}: ${reference.count} (expected ${expected}).`,
    );
  }
}
