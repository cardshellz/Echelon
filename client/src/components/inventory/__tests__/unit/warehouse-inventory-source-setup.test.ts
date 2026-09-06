import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { WarehouseInventorySourceSetup } from "../../WarehouseInventorySourceSetup";

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
function render(canEdit: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["/api/warehouses/inventory-sources"], { warehouses: [
    { id: 1, code: "LEON", name: "Main warehouse", isActive: 1, fingerprint: "a".repeat(64), source: null },
    { id: 35, code: "SM-CA", name: "Canada warehouse", isActive: 1, fingerprint: "b".repeat(64), source: { id: 4, lifecycleStatus: "draft" } },
    { id: 34, code: "SM-WEST", name: "Inactive warehouse", isActive: 0, fingerprint: "c".repeat(64), source: null },
  ] });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(WarehouseInventorySourceSetup, { canEdit })));
  } finally { client.clear(); }
}
describe("existing warehouse source setup UI", () => {
  it("uses recognizable existing warehouse names and states the inactive boundary", () => {
    const html = render(true);
    expect(html).toContain("LEON — Main warehouse");
    expect(html).toContain("SM-CA — Canada warehouse (already prepared)");
    expect(html).toContain("saves a draft only");
    expect(html).toContain("does not move stock");
    expect(html).not.toContain("Activate");
  });
  it("requires explicit authority choices rather than preselecting ownership", () => {
    const html = render(true);
    expect(html.match(/Choose explicitly/g)).toHaveLength(2);
    expect(html).toContain('value="34" disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare warehouse source<\/button>/);
  });
  it("disables editing for a view-only operator", () => {
    const html = render(false);
    expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
});
