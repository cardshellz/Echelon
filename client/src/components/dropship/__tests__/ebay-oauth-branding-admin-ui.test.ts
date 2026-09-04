import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("eBay .ops OAuth branding admin UI", () => {
  it("surfaces the provider-managed title workflow without a fake local save action", () => {
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

    expect(shell).toContain("eBay OAuth Branding");
    expect(shell).toContain("/dropship?tab=oauth-branding");
    expect(page).toContain('<TabsContent value="oauth-branding"');
    expect(panel).toContain("eBay .ops consent branding");
    expect(panel).toContain("Manage Display Title in eBay");
    expect(panel).toContain("displayTitleWritableByApi");
    expect(panel).toContain("does not expose the saved RuName Display Title");
    expect(panel).toContain("EBAY_VENDOR_RUNAME");
    expect(panel).not.toContain("Save Display Title");
  });
});
