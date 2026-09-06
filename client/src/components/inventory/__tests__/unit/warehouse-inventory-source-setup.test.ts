import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SavedWarehouseSourceSummary, WarehouseInventorySourceSetup } from "../../WarehouseInventorySourceSetup";

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
  it("reuses warehouse settings instead of asking for duplicate authority choices", () => {
    const html = render(true);
    expect(html).not.toContain("Choose explicitly");
    expect(html).not.toContain("Who owns");
    expect(html).toContain("already saved in Warehouse settings");
    expect(html).toContain('value="34" disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Prepare warehouse source<\/button>/);
  });
  it("disables editing for a view-only operator", () => {
    const html = render(false);
    expect(html.match(/<select[^>]*disabled=""/g)).toHaveLength(1);
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });
  it("clearly describes an incoming feed without exposing an internal channel ID", () => {
    const html = renderToStaticMarkup(createElement(SavedWarehouseSourceSummary, { configuration: {
      status: "ready", inventoryAuthority: "external_provider", fulfillmentAuthority: "external_provider",
      inventoryDirection: "inbound", sourceChannelId: 37,
    } }));
    expect(html).toContain("incoming inventory feed");
    expect(html).toContain("does not enable sending quantities back");
    expect(html).toContain("External warehouse");
    expect(html).not.toContain("37");
  });
  it("describes internal stock at a storage-only warehouse", () => {
    const html = renderToStaticMarkup(createElement(SavedWarehouseSourceSummary, { configuration: {
      status: "ready", inventoryAuthority: "echelon", fulfillmentAuthority: "none",
      inventoryDirection: "internal", sourceChannelId: null,
    } }));
    expect(html).toContain("Stock managed in Echelon");
    expect(html).toContain("Storage only; does not fulfill orders");
  });
  it("shows missing or unsupported settings without inventing a fallback", () => {
    expect(renderToStaticMarkup(createElement(SavedWarehouseSourceSummary, { configuration: undefined })))
      .toContain("Reload to read");
    expect(renderToStaticMarkup(createElement(SavedWarehouseSourceSummary, { configuration: {
      status: "blocked", message: "Configure the source channel first",
    } }))).toContain("Configure the source channel first");
  });
});
