import { describe, expect, it } from "vitest";
import { buildDropshipEbayOAuthBrandingConfiguration } from "../../application/dropship-ebay-oauth-branding-service";

describe("dropship eBay OAuth branding configuration", () => {
  it("identifies a dedicated .ops RuName without exposing the client secret", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration({
      DROPSHIP_EBAY_CLIENT_ID: "CardShellz-ops-production-client-id",
      DROPSHIP_EBAY_CLIENT_SECRET: "never-return-this-secret",
      EBAY_VENDOR_RUNAME: "CardShellz_CardShellz-ops-oauth",
      EBAY_ENVIRONMENT: "production",
    });

    expect(configuration).toMatchObject({
      status: "ready",
      environment: "production",
      suggestedDisplayTitle: "Card Shellz .ops",
      clientId: {
        source: "DROPSHIP_EBAY_CLIENT_ID",
        dedicated: true,
      },
      clientSecret: {
        source: "DROPSHIP_EBAY_CLIENT_SECRET",
        configured: true,
        dedicated: true,
      },
      ruName: {
        source: "EBAY_VENDOR_RUNAME",
        value: "CardShellz_CardShellz-ops-oauth",
        dedicated: true,
      },
      management: {
        mode: "external_provider_portal",
        displayTitleReadableByApi: false,
        displayTitleWritableByApi: false,
      },
    });
    expect(JSON.stringify(configuration)).not.toContain(
      "never-return-this-secret",
    );
  });

  it("warns when .ops falls back to the shared Echelon RuName", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration({
      EBAY_CLIENT_ID: "shared-ebay-client-id",
      EBAY_CLIENT_SECRET: "shared-ebay-client-secret",
      EBAY_RUNAME: "Echelon_Echelon-production-oauth",
    });

    expect(configuration).toMatchObject({
      status: "attention_required",
      clientId: {
        source: "EBAY_CLIENT_ID",
        dedicated: false,
      },
      ruName: {
        source: "EBAY_RUNAME",
        dedicated: false,
      },
    });
    expect(configuration.message).toContain("Do not rename it");
    expect(configuration.message).toContain("EBAY_VENDOR_RUNAME");
  });

  it("reports a blocked configuration when a required OAuth value is absent", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration({
      DROPSHIP_EBAY_CLIENT_ID: "configured-client-id",
      EBAY_VENDOR_RUNAME: "CardShellz_CardShellz-ops-oauth",
      EBAY_ENVIRONMENT: "sandbox",
    });

    expect(configuration).toMatchObject({
      status: "blocked",
      environment: "sandbox",
      clientSecret: {
        source: null,
        configured: false,
        dedicated: false,
      },
    });
  });

  it("uses the same dedicated-first precedence as the runtime OAuth provider", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration({
      DROPSHIP_EBAY_CLIENT_ID: "dedicated-client-id-value",
      EBAY_CLIENT_ID: "shared-client-id-value",
      DROPSHIP_EBAY_CLIENT_SECRET: "dedicated-secret",
      EBAY_CLIENT_SECRET: "shared-secret",
      EBAY_VENDOR_RUNAME: "dedicated-runame",
      EBAY_RUNAME: "shared-runame",
    });

    expect(configuration.clientId.source).toBe("DROPSHIP_EBAY_CLIENT_ID");
    expect(configuration.clientId.fingerprint).not.toContain(
      "shared-client-id-value",
    );
    expect(configuration.clientSecret.source).toBe(
      "DROPSHIP_EBAY_CLIENT_SECRET",
    );
    expect(configuration.ruName).toMatchObject({
      source: "EBAY_VENDOR_RUNAME",
      value: "dedicated-runame",
    });
  });
});
