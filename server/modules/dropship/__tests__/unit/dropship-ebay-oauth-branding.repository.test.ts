import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import type { DropshipEbayOAuthBrandingCommandContext } from "../../application/dropship-ebay-oauth-branding-service";
import { PgDropshipEbayOAuthBrandingRepository } from "../../infrastructure/dropship-ebay-oauth-branding.repository";

describe("PgDropshipEbayOAuthBrandingRepository", () => {
  it("appends an audited pending revision in one transaction", async () => {
    const client = new BrandingClient("new-request");
    const repository = repositoryFor(client);

    const result = await repository.requestCustomerFacingAppName({
      ...commandContext({ expectedRevision: 0 }),
      customerFacingAppName: "Card Shellz",
    });

    expect(result).toMatchObject({
      idempotentReplay: false,
      revision: {
        revision: 1,
        customerFacingAppName: "Card Shellz",
        providerStatus: "pending_external_update",
        action: "name_requested",
      },
    });
    expect(client.queries[0]).toBe("BEGIN");
    expect(client.queries.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);

    const revisionInsert = client.calls.find((call) =>
      call.sql.includes(
        "INSERT INTO dropship.dropship_channel_connection_branding_revisions",
      ),
    );
    expect(revisionInsert?.params).toEqual([
      "ebay",
      "dropship_vendor_store_oauth",
      "production",
      1,
      "Card Shellz",
      "a".repeat(64),
      "pending_external_update",
      "name_requested",
      "admin",
      "admin-7",
      91,
      new Date("2026-09-04T12:00:00.000Z"),
    ]);

    const auditInsert = client.calls.find((call) =>
      call.sql.includes("INSERT INTO dropship.dropship_audit_events"),
    );
    const auditPayload = JSON.parse(String(auditInsert?.params[5]));
    expect(auditPayload).toMatchObject({
      platform: "ebay",
      environment: "production",
      before: null,
      after: {
        revision: 1,
        customerFacingAppName: "Card Shellz",
        providerStatus: "pending_external_update",
      },
      idempotencyKey: "branding-request-1",
      requestHash: "request-hash",
    });
  });

  it("returns the completed revision without duplicating writes on retry", async () => {
    const client = new BrandingClient("replay");
    const repository = repositoryFor(client);

    const result = await repository.requestCustomerFacingAppName({
      ...commandContext({ expectedRevision: 0 }),
      customerFacingAppName: "Card Shellz",
    });

    expect(result.idempotentReplay).toBe(true);
    expect(result.revision.id).toBe(41);
    expect(
      client.calls.filter((call) =>
        call.sql.includes(
          "INSERT INTO dropship.dropship_channel_connection_branding_revisions",
        ),
      ),
    ).toHaveLength(0);
    expect(
      client.calls.filter((call) =>
        call.sql.includes("INSERT INTO dropship.dropship_audit_events"),
      ),
    ).toHaveLength(0);
    expect(client.queries.at(-1)).toBe("COMMIT");
  });

  it("rejects a stale revision before appending any state", async () => {
    const client = new BrandingClient("stale-request");
    const repository = repositoryFor(client);

    await expect(
      repository.requestCustomerFacingAppName({
        ...commandContext({ expectedRevision: 0 }),
        customerFacingAppName: "Card Shellz .ops",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_REVISION_CONFLICT",
      context: { expectedRevision: 0, actualRevision: 1 },
    });
    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(
      client.calls.some((call) =>
        call.sql.includes(
          "INSERT INTO dropship.dropship_channel_connection_branding_revisions",
        ),
      ),
    ).toBe(false);
  });

  it("appends manual verification while preserving the requested name", async () => {
    const client = new BrandingClient("verify");
    const repository = repositoryFor(client);

    const result = await repository.confirmExternalUpdate(
      commandContext({
        expectedRevision: 1,
        idempotencyKey: "branding-verify-1",
      }),
    );

    expect(result).toMatchObject({
      idempotentReplay: false,
      revision: {
        revision: 2,
        customerFacingAppName: "Card Shellz",
        providerStatus: "manually_verified",
        action: "external_update_verified",
      },
    });
    const revisionInsert = client.calls.find((call) =>
      call.sql.includes(
        "INSERT INTO dropship.dropship_channel_connection_branding_revisions",
      ),
    );
    expect(revisionInsert?.params.slice(3, 8)).toEqual([
      2,
      "Card Shellz",
      "a".repeat(64),
      "manually_verified",
      "external_update_verified",
    ]);
  });

  it("rejects a duplicate desired value under a different command key", async () => {
    const client = new BrandingClient("unchanged");
    const repository = repositoryFor(client);

    await expect(
      repository.requestCustomerFacingAppName({
        ...commandContext({ expectedRevision: 1 }),
        customerFacingAppName: "Card Shellz",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_UNCHANGED",
    });
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });

  it("rejects confirmation when the latest revision is no longer pending", async () => {
    const client = new BrandingClient("not-pending");
    const repository = repositoryFor(client);

    await expect(
      repository.confirmExternalUpdate(
        commandContext({
          expectedRevision: 1,
          idempotencyKey: "branding-verify-2",
        }),
      ),
    ).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_NOT_PENDING",
      context: { providerStatus: "manually_verified" },
    });
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });

  it("allows reconfirmation when the active provider resource changed", async () => {
    const client = new BrandingClient("verify-changed-resource");
    const repository = repositoryFor(client);

    const result = await repository.confirmExternalUpdate(
      commandContext({
        expectedRevision: 1,
        idempotencyKey: "branding-verify-changed-resource",
      }),
    );

    expect(result.revision).toMatchObject({
      revision: 2,
      providerResourceFingerprint: "a".repeat(64),
      providerStatus: "manually_verified",
    });
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const client = new BrandingClient("idempotency-conflict");
    const repository = repositoryFor(client);

    await expect(
      repository.requestCustomerFacingAppName({
        ...commandContext(),
        customerFacingAppName: "Card Shellz",
      }),
    ).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_OAUTH_BRANDING_IDEMPOTENCY_CONFLICT",
      context: { requestHashMatches: false },
    });
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });
});

type BrandingScenario =
  | "new-request"
  | "replay"
  | "stale-request"
  | "verify"
  | "unchanged"
  | "not-pending"
  | "verify-changed-resource"
  | "idempotency-conflict";

class BrandingClient {
  readonly queries: string[] = [];
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  released = false;

  constructor(private readonly scenario: BrandingScenario) {}

  async query<T>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);
    this.calls.push({ sql: normalized, params });

    if (
      normalized.includes(
        "INSERT INTO dropship.dropship_admin_config_commands",
      )
    ) {
      return result(
        this.scenario === "replay" ||
          this.scenario === "idempotency-conflict"
          ? []
          : [{ id: 91 } as T],
      );
    }
    if (
      normalized.includes("FROM dropship.dropship_admin_config_commands")
    ) {
      return result([
        {
          id: 91,
          command_type:
            "dropship_ebay_customer_facing_app_name_requested",
          request_hash:
            this.scenario === "idempotency-conflict"
              ? "different-request-hash"
              : "request-hash",
          entity_type: "dropship_channel_connection_branding_revisions",
          entity_id: "41",
        } as T,
      ]);
    }
    if (
      normalized.includes(
        "FROM dropship.dropship_channel_connection_branding_revisions",
      ) && normalized.includes("WHERE id = $1")
    ) {
      return result([brandingRow({ id: 41 }) as T]);
    }
    if (
      normalized.includes(
        "FROM dropship.dropship_channel_connection_branding_revisions",
      ) && normalized.includes("ORDER BY revision DESC")
    ) {
      return result(
        this.scenario === "stale-request" ||
          this.scenario === "verify" ||
          this.scenario === "verify-changed-resource" ||
          this.scenario === "unchanged" ||
          this.scenario === "not-pending"
          ? [
              brandingRow(
                this.scenario === "not-pending" ||
                  this.scenario === "verify-changed-resource"
                  ? {
                      provider_status: "manually_verified",
                      action: "external_update_verified",
                      ...(this.scenario === "verify-changed-resource"
                        ? { provider_resource_fingerprint: "b".repeat(64) }
                        : {}),
                    }
                  : {},
              ) as T,
            ]
          : [],
      );
    }
    if (
      normalized.includes(
        "INSERT INTO dropship.dropship_channel_connection_branding_revisions",
      )
    ) {
      const verified =
        this.scenario === "verify" ||
        this.scenario === "verify-changed-resource";
      return result([
        brandingRow({
          id: verified ? 42 : 41,
          revision: verified ? 2 : 1,
          provider_status: verified
            ? "manually_verified"
            : "pending_external_update",
          action: verified
            ? "external_update_verified"
            : "name_requested",
        }) as T,
      ]);
    }
    if (
      normalized.includes("UPDATE dropship.dropship_admin_config_commands")
    ) {
      return result([{ id: 91 } as T]);
    }
    return result([]);
  }

  release(): void {
    this.released = true;
  }
}

function repositoryFor(
  client: BrandingClient,
): PgDropshipEbayOAuthBrandingRepository {
  const pool = {
    connect: async () => client as unknown as PoolClient,
  } as unknown as Pool;
  return new PgDropshipEbayOAuthBrandingRepository(pool);
}

function commandContext(
  overrides: Partial<DropshipEbayOAuthBrandingCommandContext> = {},
): DropshipEbayOAuthBrandingCommandContext {
  return {
    environment: "production",
    providerResourceFingerprint: "a".repeat(64),
    expectedRevision: 0,
    idempotencyKey: "branding-request-1",
    requestHash: "request-hash",
    actor: { actorType: "admin", actorId: "admin-7" },
    now: new Date("2026-09-04T12:00:00.000Z"),
    ...overrides,
  };
}

function brandingRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 40,
    platform: "ebay",
    use_case: "dropship_vendor_store_oauth",
    environment: "production",
    revision: 1,
    customer_facing_app_name: "Card Shellz",
    provider_resource_fingerprint: "a".repeat(64),
    provider_status: "pending_external_update",
    action: "name_requested",
    actor_type: "admin",
    actor_id: "admin-7",
    created_at: new Date("2026-09-04T12:00:00.000Z"),
    ...overrides,
  };
}

function result<T>(rows: T[]): QueryResult<T> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}
