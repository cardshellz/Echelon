import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("shipping fulfillment routing admin UI", () => {
  it("replaces the planned placeholder with an explicit selectable provider catalog", () => {
    const detail = readFileSync(
      join(process.cwd(), "client", "src", "pages", "ShippingServiceLevelDetail.tsx"),
      "utf8",
    );
    const editor = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "components",
        "shipping",
        "service-levels",
        "FulfillmentRoutingEditor.tsx",
      ),
      "utf8",
    );
    expect(detail).toContain("<FulfillmentRoutingEditor");
    expect(detail).not.toContain("Provider routing is not configured in the initial rollout");
    expect(editor).toContain("Allowed routing methods");
    expect(editor).toContain("Connected provider catalog");
    expect(editor).toContain("A connected method is only available to route after you select and save it here.");
    expect(editor).toContain("onChange={(event) => setSearch(event.target.value)}");
    expect(editor).toContain("Save fulfillment routing");
    expect(editor).toContain("No longer available");
    expect(editor).toContain("groupFulfillmentCatalogMethodsByScope(filteredCatalog)");
    expect(editor).toContain("Domestic");
    expect(editor).toContain("International");
    expect(editor).not.toContain("variant</span>");
    expect(editor).toContain('aria-label="Selected routing methods"');
    expect(editor).toContain("max-h-56 divide-y overflow-y-auto rounded-md border");
    expect(editor).toContain("Exact provider routing identity");
    expect(editor).toContain("Provider capabilities");
    expect(editor).not.toContain("<MethodCapabilitySummary capabilities={row.method.capabilities} />");
    expect(editor).toContain("Provider catalog refreshed");
    expect(editor).toContain("Refreshing catalog...");
    expect(editor).toContain("Last provider refresh:");
    expect(editor).toContain("Provider flags: multi-package");
    expect(detail).toContain("Save fulfillment routing before review");
    expect(detail).toContain("The routing resolver will fail closed");
  });

  it("surfaces provider connection management separately from service-level routing", () => {
    const settings = readFileSync(
      join(process.cwd(), "client", "src", "pages", "ShippingSettings.tsx"),
      "utf8",
    );
    const connections = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "components",
        "shipping",
        "provider-connections",
        "FulfillmentProviderConnectionsTab.tsx",
      ),
      "utf8",
    );

    expect(settings).toContain('TabsTrigger value="fulfillment-providers"');
    expect(connections).toContain("Connect fulfillment provider");
    expect(connections).toMatch(/Service levels map to methods from these\s+connections/);
    expect(connections).toContain("The credential is verified before it is encrypted and stored");
    expect(connections).not.toMatch(/value=\{connection\.credential\}/);
  });
});
