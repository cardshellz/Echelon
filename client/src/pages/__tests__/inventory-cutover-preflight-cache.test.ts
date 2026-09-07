import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryCutoverPreflightPanel } from "../inventory-cutover-preflight-panel";
import type { InventoryCutoverPreflight } from "@shared/types/inventory-cutover-preflight";

afterEach(() => vi.unstubAllGlobals());

describe("cutover preflight operator cache isolation", () => {
  it("does not show operator A's retained snapshot to operator B or an anonymous session", () => {
    const client = new QueryClient();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client.setQueryData(["/api/inventory-planning/admin/cutover-preflight", "operator-a"], report());
    expect(render(client, "operator-a")).toContain("OPERATOR_A_SNAPSHOT");
    expect(render(client, "operator-b")).not.toContain("OPERATOR_A_SNAPSHOT");
    expect(render(client, "operator-b")).toContain("No snapshot captured");
    expect(render(client, null)).toBe("");
    expect(render(client, "")).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
    client.clear();
  });

  it("does not adopt a legacy unscoped cache entry", () => {
    const client = new QueryClient();
    client.setQueryData(["/api/inventory-planning/admin/cutover-preflight"], report());
    expect(render(client, "operator-b")).not.toContain("OPERATOR_A_SNAPSHOT");
    expect(render(client, "operator-b")).toContain("Capture read-only evidence");
    client.clear();
  });
});

function render(client: QueryClient, actorId: string | null): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client },
    createElement(InventoryCutoverPreflightPanel, { canView: true, actorId })));
}

function report(): InventoryCutoverPreflight {
  return {
    contractVersion: "inventory_cutover_preflight_v1", scope: "nonterminal_wms_demand_and_current_inventory_encumbrances",
    capturedAt: "2026-09-07T14:00:00.000Z", evidenceHash: "a".repeat(64), runtimeAuthority: "legacy", authorityRevision: "1",
    outcome: "evidence_captured", operationalWriteAttempted: false, activationReadinessEvaluated: false,
    excludedTerminalOrderCount: "0", summary: { orders: 0, lines: 0, unstartedDemandLines: 0, noInventoryDemandLines: 0,
      reviewLines: 0, inventoryLevels: 0, unattributedReservationLevels: 0 }, lines: [], inventoryLevels: [], findings: [],
    notEvaluated: ["OPERATOR_A_SNAPSHOT"],
  };
}
