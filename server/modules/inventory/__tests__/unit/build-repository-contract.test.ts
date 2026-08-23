import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositorySource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/inventory/infrastructure/build.repository.ts"),
  "utf8",
);
const executionSource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/inventory/infrastructure/build-execution.repository.ts"),
  "utf8",
);
const querySource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/inventory/infrastructure/build-query.repository.ts"),
  "utf8",
);

describe("build repository transaction contract", () => {
  it("keeps recipe configuration separate from execution orchestration", () => {
    expect(repositorySource).toContain("new BuildExecutionRepository");
    expect(repositorySource).toContain("return this.execution.executeOrder(input)");
    expect(repositorySource).not.toContain("INSERT INTO inventory.build_runs");
  });

  it("requires build-managed product policy for recipe and order creation", () => {
    expect(repositorySource).toContain("assertRecipeManagedOutputProduct");
    expect(repositorySource).toContain("BUILD_OUTPUT_STRATEGY_REQUIRED");
    expect(repositorySource).toContain("outputFacts.productId");
    expect(repositorySource).toContain("recipe.output_product_id");
  });

  it("locks the order, components, levels, reservations, and FIFO lots before mutation", () => {
    expect(executionSource).toMatch(/build_orders[\s\S]*FOR UPDATE/);
    expect(executionSource).toMatch(/build_order_components[\s\S]*FOR UPDATE/);
    expect(executionSource).toMatch(/inventory_levels[\s\S]*FOR UPDATE/);
    expect(executionSource).toMatch(/ORDER BY lot\.received_at, lot\.id[\s\S]*FOR UPDATE OF reservation, lot/);
  });

  it("owns exact component reservations at release", () => {
    expect(executionSource).toContain("inventory.build_component_reservations");
    expect(executionSource).toContain("reserved_qty - consumed_qty - released_qty");
    expect(executionSource).toContain("SET reserved_qty = reserved_qty +");
    expect(executionSource).toContain("'reserve'");
  });

  it("posts independently idempotent partial runs", () => {
    expect(executionSource).toContain("calculateBuildRunQuantities");
    expect(executionSource).toContain("WHERE idempotency_key =");
    expect(executionSource).toContain("INSERT INTO inventory.build_runs");
    expect(executionSource).toContain("builds_completed");
    expect(executionSource).toContain("alreadyPosted");
  });

  it("records immutable FIFO consumption and exact integer-mill output cost layers", () => {
    expect(executionSource).toContain("inventory.build_run_consumptions");
    expect(executionSource).toContain("allocateBuildCostLayers(consumedCost, quantities.outputQty)");
    expect(executionSource).toContain("po_unit_cost_mills");
    expect(executionSource).toContain("packaging_cost_mills");
    expect(executionSource).toContain("landed_cost_mills");
    expect(executionSource).toContain("build_run_id");
  });

  it("cancels only open reservations and records unreserve ledger evidence", () => {
    expect(executionSource).toContain("releaseOpenReservations");
    expect(executionSource).toContain("reserved_qty > reservation.consumed_qty + reservation.released_qty");
    expect(executionSource).toContain("'unreserve'");
    expect(executionSource).toContain("cancellation_reason");
    expect(executionSource).toContain("BUILD_CANCELLATION_CONFLICT");
    expect(executionSource).toContain("cancelled_reservation_qty");
    expect(executionSource).toContain('String(order.cancellation_reason ?? "") !== input.reason');
  });

  it("hydrates order components and runs sequentially on a single pg client", () => {
    expect(querySource).toContain("await this.loadOrderComponents(orderIds)");
    expect(querySource).toContain("await this.loadOrderRuns(orderIds)");
    expect(querySource).not.toMatch(/componentsByOrder, runsByOrder.*Promise\.all/);
  });

  it("uses compensating reversal instead of rewriting posted evidence", () => {
    expect(executionSource).toContain("assertBuildRunOutputUntouched");
    expect(executionSource).toContain("inventory.build_run_reversals");
    expect(executionSource).toContain("'build_reversal'");
    expect(executionSource).toContain("latestPostedRunId");
    expect(executionSource).toContain("resultingOrderStatus");
    expect(executionSource).toContain("resulting_completed_builds");
    expect(executionSource).toContain("SET status = 'reversed'");
  });
});
