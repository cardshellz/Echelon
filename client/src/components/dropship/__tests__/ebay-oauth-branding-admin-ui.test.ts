import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("eBay .ops OAuth branding admin UI", () => {
  it("surfaces the provider-managed title workflow within Store Connections", () => {
    const panel = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "components",
        "dropship",
        "EbayOAuthBrandingAdminPanel.tsx",
      ),
      "utf8",
    );
    const page = readFileSync(
      join(process.cwd(), "client", "src", "pages", "Dropship.tsx"),
      "utf8",
    );
    const storeConnectionsModule = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "pages",
        "dropship-admin",
        "StoreConnectionOpsTab.tsx",
      ),
      "utf8",
    );
    const shell = readFileSync(
      join(
        process.cwd(),
        "client",
        "src",
        "components",
        "layout",
        "AppShell.tsx",
      ),
      "utf8",
    );

    expect(shell).toContain("Store Connections");
    expect(shell).not.toContain("/dropship?tab=oauth-branding");
    expect(page).not.toContain('<TabsContent value="oauth-branding"');
    expect(page).toContain('import("./dropship-admin/StoreConnectionOpsTab")');
    expect(page).toContain('<TabsContent value="stores" className="m-0">');
    expect(page).toContain("<StoreConnectionOpsTab />");
    const storeConnectionsStart = storeConnectionsModule.indexOf(
      "function StoreConnectionOpsTab()",
    );
    const brandingPanelRender = storeConnectionsModule.indexOf(
      "<EbayOAuthBrandingAdminPanel />",
      storeConnectionsStart,
    );
    expect(storeConnectionsStart).toBeGreaterThanOrEqual(0);
    expect(brandingPanelRender).toBeGreaterThan(storeConnectionsStart);
    expect(panel).toContain("Connection branding");
    expect(panel).toContain("Customer-facing app name");
    expect(panel).toContain("Save requested name");
    expect(panel).toContain("putJson<DropshipEbayOAuthBrandingMutationResponse>");
    expect(panel).toContain("Action required in eBay");
    expect(panel).toContain("I updated the eBay Display Title");
    expect(panel).toContain("Technical connection details");
    expect(panel).not.toContain("eBay .ops consent branding");
  });
});
