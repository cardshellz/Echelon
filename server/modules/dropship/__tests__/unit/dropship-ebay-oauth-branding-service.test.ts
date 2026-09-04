import { createHash } from "crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildDropshipEbayOAuthBrandingConfiguration,
  DropshipEbayOAuthBrandingService,
  hashEbayOAuthBrandingCommand,
  type DropshipEbayOAuthBrandingRepository,
  type DropshipEbayOAuthBrandingRevision,
} from "../../application/dropship-ebay-oauth-branding-service";

const dedicatedEnvironment: NodeJS.ProcessEnv = {
  DROPSHIP_EBAY_CLIENT_ID: "CardShellz-ops-production-client-id",
  DROPSHIP_EBAY_CLIENT_SECRET: "never-return-this-secret",
  EBAY_VENDOR_RUNAME: "CardShellz_CardShellz-ops-oauth",
  EBAY_ENVIRONMENT: "production",
};

describe("dropship eBay OAuth branding configuration", () => {
  it("identifies a dedicated .ops RuName without exposing the client secret", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration(
      dedicatedEnvironment,
    );

    expect(configuration).toMatchObject({
      status: "ready",
      environment: "production",
      suggestedDisplayTitle: "Card Shellz .ops",
      customerFacingAppName: {
        value: "Card Shellz .ops",
        source: "default",
        revision: 0,
        providerStatus: "not_saved",
      },
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
    expect(configuration.message).toContain("shared Echelon RuName");
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

  it("surfaces the latest immutable saved revision", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration(
      dedicatedEnvironment,
      revision({
        revision: 4,
        customerFacingAppName: "Card Shellz",
        providerStatus: "manually_verified",
        action: "external_update_verified",
      }),
    );

    expect(configuration.customerFacingAppName).toEqual({
      value: "Card Shellz",
      source: "saved",
      revision: 4,
      providerStatus: "manually_verified",
      providerResourceChanged: false,
      updatedAt: new Date("2026-09-04T12:00:00.000Z"),
      updatedBy: "admin-7",
    });
  });

  it("requires the provider step again when the active eBay app or RuName changes", () => {
    const configuration = buildDropshipEbayOAuthBrandingConfiguration(
      dedicatedEnvironment,
      revision({
        revision: 4,
        providerStatus: "manually_verified",
        action: "external_update_verified",
        providerResourceFingerprint: "b".repeat(64),
      }),
    );

    expect(configuration.customerFacingAppName).toMatchObject({
      revision: 4,
      providerStatus: "pending_external_update",
      providerResourceChanged: true,
    });
  });

  it("normalizes, hashes, persists, and reports a requested name", async () => {
    const storedRevision = revision({
      revision: 1,
      customerFacingAppName: "Card Shellz",
      providerStatus: "pending_external_update",
      action: "name_requested",
    });
    const repository = fakeRepository();
    vi.mocked(repository.requestCustomerFacingAppName).mockResolvedValue({
      revision: storedRevision,
      idempotentReplay: false,
    });
    const now = new Date("2026-09-04T12:00:00.000Z");
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new DropshipEbayOAuthBrandingService({
      env: dedicatedEnvironment,
      repository,
      clock: { now: () => now },
      logger,
    });

    const result = await service.requestCustomerFacingAppName({
      customerFacingAppName: "  Card Shellz  ",
      expectedRevision: 0,
      idempotencyKey: "branding-request-1",
      actor: { actorType: "admin", actorId: "admin-7" },
    });

    expect(repository.requestCustomerFacingAppName).toHaveBeenCalledWith({
      customerFacingAppName: "Card Shellz",
      environment: "production",
      providerResourceFingerprint: dedicatedProviderFingerprint(),
      expectedRevision: 0,
      idempotencyKey: "branding-request-1",
      requestHash: hashEbayOAuthBrandingCommand(
        "dropship_ebay_customer_facing_app_name_requested",
        {
          customerFacingAppName: "Card Shellz",
          expectedRevision: 0,
          environment: "production",
          providerResourceFingerprint: dedicatedProviderFingerprint(),
        },
      ),
      actor: { actorType: "admin", actorId: "admin-7" },
      now,
    });
    expect(result.configuration.customerFacingAppName).toMatchObject({
      value: "Card Shellz",
      revision: 1,
      providerStatus: "pending_external_update",
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DROPSHIP_EBAY_BRANDING_REQUESTED" }),
    );
  });

  it("rejects invalid names before calling the repository", async () => {
    const repository = fakeRepository();
    const service = serviceWithRepository(repository);

    await expect(
      service.requestCustomerFacingAppName({
        customerFacingAppName: `Card${String.fromCharCode(0)}Shellz`,
        expectedRevision: 0,
        idempotencyKey: "branding-request-2",
        actor: { actorType: "admin", actorId: "admin-7" },
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(repository.requestCustomerFacingAppName).not.toHaveBeenCalled();
  });

  it("records a successful manual provider confirmation against the current revision", async () => {
    const repository = fakeRepository();
    const confirmedRevision = revision({
      id: 12,
      revision: 2,
      providerStatus: "manually_verified",
      action: "external_update_verified",
    });
    vi.mocked(repository.confirmExternalUpdate).mockResolvedValue({
      revision: confirmedRevision,
      idempotentReplay: false,
    });
    const now = new Date("2026-09-04T12:05:00.000Z");
    const service = new DropshipEbayOAuthBrandingService({
      env: dedicatedEnvironment,
      repository,
      clock: { now: () => now },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const result = await service.confirmExternalUpdate({
      expectedRevision: 1,
      idempotencyKey: "branding-verify-2",
      actor: { actorType: "admin", actorId: "admin-7" },
    });

    expect(repository.confirmExternalUpdate).toHaveBeenCalledWith({
      environment: "production",
      providerResourceFingerprint: dedicatedProviderFingerprint(),
      expectedRevision: 1,
      idempotencyKey: "branding-verify-2",
      requestHash: hashEbayOAuthBrandingCommand(
        "dropship_ebay_customer_facing_app_name_verified",
        {
          expectedRevision: 1,
          environment: "production",
          providerResourceFingerprint: dedicatedProviderFingerprint(),
        },
      ),
      actor: { actorType: "admin", actorId: "admin-7" },
      now,
    });
    expect(result.configuration.customerFacingAppName).toMatchObject({
      revision: 2,
      providerStatus: "manually_verified",
    });
  });

  it("requires a dedicated RuName before accepting manual provider verification", async () => {
    const repository = fakeRepository();
    const service = new DropshipEbayOAuthBrandingService({
      env: {
        EBAY_CLIENT_ID: "shared-client",
        EBAY_CLIENT_SECRET: "shared-secret",
        EBAY_RUNAME: "shared-runame",
      },
      repository,
      clock: { now: () => new Date("2026-09-04T12:00:00.000Z") },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      service.confirmExternalUpdate({
        expectedRevision: 1,
        idempotencyKey: "branding-verify-1",
        actor: { actorType: "admin", actorId: "admin-7" },
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_DEDICATED_RUNAME_REQUIRED",
    });
    expect(repository.confirmExternalUpdate).not.toHaveBeenCalled();
  });
});

function revision(
  overrides: Partial<DropshipEbayOAuthBrandingRevision> = {},
): DropshipEbayOAuthBrandingRevision {
  return {
    id: 11,
    platform: "ebay",
    useCase: "dropship_vendor_store_oauth",
    environment: "production",
    revision: 1,
    customerFacingAppName: "Card Shellz",
    providerResourceFingerprint: dedicatedProviderFingerprint(),
    providerStatus: "pending_external_update",
    action: "name_requested",
    actorType: "admin",
    actorId: "admin-7",
    createdAt: new Date("2026-09-04T12:00:00.000Z"),
    ...overrides,
  };
}

function dedicatedProviderFingerprint(): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        clientId: dedicatedEnvironment.DROPSHIP_EBAY_CLIENT_ID,
        ruName: dedicatedEnvironment.EBAY_VENDOR_RUNAME,
      }),
    )
    .digest("hex");
}

function fakeRepository(): DropshipEbayOAuthBrandingRepository {
  return {
    loadCurrent: vi.fn().mockResolvedValue(null),
    requestCustomerFacingAppName: vi.fn(),
    confirmExternalUpdate: vi.fn(),
  };
}

function serviceWithRepository(
  repository: DropshipEbayOAuthBrandingRepository,
): DropshipEbayOAuthBrandingService {
  return new DropshipEbayOAuthBrandingService({
    env: dedicatedEnvironment,
    repository,
    clock: { now: () => new Date("2026-09-04T12:00:00.000Z") },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}
