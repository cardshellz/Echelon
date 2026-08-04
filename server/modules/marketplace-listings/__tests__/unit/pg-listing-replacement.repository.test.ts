import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { ListingReplacementReplayLookup } from "../../application/ports";
import {
  buildListingReplacementPlan,
  type ListingReplacementPlan,
} from "../../domain/listing-replacement-plan";
import { PgMarketplaceListingReplacementRepository } from "../../infrastructure/pg-listing-replacement.repository";

describe("PgMarketplaceListingReplacementRepository", () => {
  it("loads a stable owner-scoped replay and rejects a changed request hash", async () => {
    const plan = replacementPlan();
    const operation = operationRow(plan);
    const harness = makeHarness({
      poolSteps: [
        {
          includes: "JOIN marketplace.channel_listing_scopes",
          rows: [operation],
        },
        {
          includes: "JOIN marketplace.channel_listing_scopes",
          rows: [operation],
        },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );
    const lookup = replayLookup(plan);

    await expect(repository.findReplay(lookup)).resolves.toMatchObject({
      operationId: 3001,
      requestHash: plan.requestHash,
    });
    await expect(
      repository.findReplay({
        ...lookup,
        requestHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_IDEMPOTENCY_CONFLICT",
    });

    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.poolQuery).toHaveBeenNthCalledWith(1, expect.any(String), [
      "ebay",
      "EBAY_US",
      33,
      7,
      plan.idempotencyKey,
    ]);
    expect(harness.remainingPoolSteps()).toBe(0);
  });

  it("loads a dropship-owner replay through the dropship binding", async () => {
    const plan = replacementPlan();
    const operation = operationRow(plan);
    const lookup: ListingReplacementReplayLookup = {
      owner: {
        kind: "dropship",
        storeConnectionId: 91,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      idempotencyKey: plan.idempotencyKey,
      requestHash: plan.requestHash,
    };
    const harness = makeHarness({
      poolSteps: [
        {
          includes: "JOIN marketplace.dropship_listing_scopes",
          rows: [operation],
        },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.findReplay(lookup)).resolves.toMatchObject({
      operationId: 3001,
    });
    expect(harness.poolQuery).toHaveBeenCalledWith(expect.any(String), [
      "ebay",
      "EBAY_US",
      33,
      91,
      plan.idempotencyKey,
    ]);
    expect(harness.connect).not.toHaveBeenCalled();
    expect(harness.remainingPoolSteps()).toBe(0);
  });

  it.each([
    { label: "null", error: null },
    { label: "undefined", error: undefined },
  ])(
    "classifies a $label replay rejection without throwing while inspecting it",
    async ({ error }) => {
      const plan = replacementPlan();
      const harness = makeHarness({
        poolSteps: [
          {
            includes: "JOIN marketplace.channel_listing_scopes",
            error,
            throws: true,
          },
        ],
      });
      const repository = new PgMarketplaceListingReplacementRepository(
        harness.pool,
      );

      await expect(
        repository.findReplay(replayLookup(plan)),
      ).rejects.toMatchObject({
        code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
        context: { postgresCode: null, constraint: null },
      });
      expect(harness.remainingPoolSteps()).toBe(0);
    },
  );

  it.each([
    { label: "null", error: null },
    { label: "undefined", error: undefined },
  ])("classifies a $label pool connection rejection", async ({ error }) => {
    const plan = replacementPlan();
    const connect = vi.fn(async () => {
      throw error;
    });
    const pool = { connect } as unknown as Pool;
    const repository = new PgMarketplaceListingReplacementRepository(pool);

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
      context: { postgresCode: null, constraint: null },
    });
    expect(connect).toHaveBeenCalledOnce();
  });

  it("commits a complete creation only after writing the initial event", async () => {
    const plan = replacementPlan();
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          rows: [operationRow(plan)],
          values: operationInsertValues(plan),
        },
        {
          includes: "INSERT INTO marketplace.listing_replacement_steps",
          rows: persistedStepRows(plan),
          values: stepInsertValues(plan),
        },
        ...initialEventSteps(plan),
        { includes: "COMMIT" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).resolves.toMatchObject({
      kind: "created",
      operation: { operationId: 3001 },
    });
    const executed = harness.executedSql();
    expect(
      executed.filter((sql) =>
        sql.includes("INSERT INTO marketplace.listing_replacement_events"),
      ),
    ).toHaveLength(plan.steps.length + 1);
    expect(executed.at(-2)).toContain(
      "INSERT INTO marketplace.listing_replacement_events",
    );
    expect(executed.at(-1)).toBe("COMMIT");
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("replays inside the scope lock when the early lookup missed a concurrent winner", async () => {
    const plan = replacementPlan();
    const harness = makeHarness({
      clientSteps: [
        { includes: "BEGIN" },
        { includes: "SET LOCAL lock_timeout" },
        {
          includes: "FROM marketplace.listing_scopes",
          rows: [scopeRow()],
          values: [plan.scopeId],
        },
        {
          includes: "FROM marketplace.listing_replacement_operations",
          rows: [operationRow(plan)],
          values: [plan.scopeId, plan.idempotencyKey],
        },
        { includes: "COMMIT" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).resolves.toMatchObject({
      kind: "replay",
      operation: {
        operationId: 3001,
        idempotencyKey: plan.idempotencyKey,
        requestHash: plan.requestHash,
      },
    });
    expect(
      harness.executedSql().some((sql) => sql.startsWith("INSERT INTO")),
    ).toBe(false);
    expect(harness.executedSql().at(-1)).toBe("COMMIT");
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rejects a scope owner mismatch and rolls back without writing", async () => {
    const plan = replacementPlan();
    const harness = makeHarness({
      clientSteps: [
        { includes: "BEGIN" },
        { includes: "SET LOCAL lock_timeout" },
        {
          includes: "FROM marketplace.listing_scopes",
          rows: [{ ...scopeRow(), channel_id: 8 }],
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_SCOPE_OWNER_MISMATCH",
      context: { scopeId: plan.scopeId, ownerKind: "channel" },
    });
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rejects a stale target generation before inserting the target", async () => {
    const plan = replacementPlan();
    const harness = makeHarness({
      clientSteps: [
        { includes: "BEGIN" },
        { includes: "SET LOCAL lock_timeout" },
        { includes: "FROM marketplace.listing_scopes", rows: [scopeRow()] },
        {
          includes: "FROM marketplace.listing_replacement_operations",
          rows: [],
        },
        {
          includes: "FROM marketplace.listing_publications",
          rows: [sourcePublicationRow(plan)],
        },
        {
          includes: "SELECT COALESCE(MAX(generation), 0)",
          rows: [{ max_generation: plan.targetGeneration }],
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_PLANNING_CONTEXT_STALE",
      context: { scopeId: plan.scopeId },
    });
    expect(
      harness
        .executedSql()
        .some((sql) =>
          sql.includes("INSERT INTO marketplace.listing_publications"),
        ),
    ).toBe(false);
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rejects an incomplete target-member insert", async () => {
    const plan = replacementPlan();
    const clientSteps = creationPrefix(plan);
    clientSteps[clientSteps.length - 1] = {
      includes: "INSERT INTO marketplace.listing_publication_members",
      rowCount: plan.targetMembers.length - 1,
      values: targetMemberInsertValues(plan),
    };
    clientSteps.push({ includes: "ROLLBACK" });
    const harness = makeHarness({ clientSteps });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_MEMBER_WRITE_INCOMPLETE",
      context: {
        expected: plan.targetMembers.length,
        actual: plan.targetMembers.length - 1,
      },
    });
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rejects an incomplete replacement-step insert", async () => {
    const plan = replacementPlan();
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          rows: [operationRow(plan)],
          values: operationInsertValues(plan),
        },
        {
          includes: "INSERT INTO marketplace.listing_replacement_steps",
          rows: persistedStepRows(plan).slice(0, -1),
          rowCount: plan.steps.length - 1,
          values: stepInsertValues(plan),
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_STEP_WRITE_INCOMPLETE",
      context: {
        expected: plan.steps.length,
        actual: plan.steps.length - 1,
      },
    });
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("classifies PostgreSQL lock timeout as a concurrent update", async () => {
    const plan = replacementPlan();
    const lockError = Object.assign(new Error("lock timeout"), {
      code: "55P03",
    });
    const harness = makeHarness({
      clientSteps: [
        { includes: "BEGIN" },
        { includes: "SET LOCAL lock_timeout" },
        {
          includes: "FROM marketplace.listing_scopes",
          error: lockError,
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_CONCURRENT_UPDATE",
      context: { scopeId: plan.scopeId },
      cause: lockError,
    });
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("classifies the active-operation uniqueness race", async () => {
    const plan = replacementPlan();
    const activeOperationError = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "listing_replacement_operations_active_scope_uidx",
    });
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          error: activeOperationError,
          values: operationInsertValues(plan),
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_ALREADY_ACTIVE",
      context: { scopeId: plan.scopeId },
      cause: activeOperationError,
    });
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("classifies the publication-generation uniqueness race as stale context", async () => {
    const plan = replacementPlan();
    const generationError = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "listing_publications_scope_generation_uq",
    });
    const clientSteps = creationPrefix(plan).slice(0, -2);
    clientSteps.push(
      {
        includes: "INSERT INTO marketplace.listing_publications",
        error: generationError,
        values: targetPublicationInsertValues(plan),
      },
      { includes: "ROLLBACK" },
    );
    const harness = makeHarness({ clientSteps });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_PLANNING_CONTEXT_STALE",
      context: { scopeId: plan.scopeId },
    });
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("validates a created operation row before committing", async () => {
    const plan = replacementPlan();
    const invalidOperation = {
      ...operationRow(plan),
      status: "database-corruption",
    };
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          rows: [invalidOperation],
          values: operationInsertValues(plan),
        },
        {
          includes: "INSERT INTO marketplace.listing_replacement_steps",
          rows: persistedStepRows(plan),
          values: stepInsertValues(plan),
        },
        ...initialEventSteps(plan),
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
    });
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("validates a replay operation row before committing", async () => {
    const plan = replacementPlan();
    const invalidOperation = {
      ...operationRow(plan),
      current_phase: "unknown",
    };
    const harness = makeHarness({
      clientSteps: [
        { includes: "BEGIN" },
        { includes: "SET LOCAL lock_timeout" },
        { includes: "FROM marketplace.listing_scopes", rows: [scopeRow()] },
        {
          includes: "FROM marketplace.listing_replacement_operations",
          rows: [invalidOperation],
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
    });
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rolls back before audit creation when returned step data differs from the plan", async () => {
    const plan = replacementPlan();
    const rows = persistedStepRows(plan);
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          rows: [operationRow(plan)],
          values: operationInsertValues(plan),
        },
        {
          includes: "INSERT INTO marketplace.listing_replacement_steps",
          rows: [{ ...rows[0], phase: "verify" }, ...rows.slice(1)],
          values: stepInsertValues(plan),
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_CONTRACT_ERROR",
    });
    expect(
      harness
        .executedSql()
        .some((sql) =>
          sql.includes("INSERT INTO marketplace.listing_replacement_events"),
        ),
    ).toBe(false);
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("rolls back the whole transaction after a mid-write failure", async () => {
    const plan = replacementPlan();
    const writeError = Object.assign(new Error("step insert failed"), {
      code: "XX001",
    });
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan),
        {
          includes: "INSERT INTO marketplace.listing_replacement_operations",
          rows: [operationRow(plan)],
          values: operationInsertValues(plan),
        },
        {
          includes: "INSERT INTO marketplace.listing_replacement_steps",
          error: writeError,
          values: stepInsertValues(plan),
        },
        { includes: "ROLLBACK" },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    await expect(repository.createOrReplayPlan(plan)).rejects.toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
      context: expect.objectContaining({ postgresCode: "XX001" }),
    });
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.executedSql().at(-1)).toBe("ROLLBACK");
    expect(harness.release).toHaveBeenCalledWith();
    expect(harness.remainingClientSteps()).toBe(0);
  });

  it("exposes both failures and destroys the client when rollback fails", async () => {
    const plan = replacementPlan();
    const writeError = Object.assign(new Error("member insert failed"), {
      code: "XX002",
    });
    const rollbackError = Object.assign(
      new Error("connection lost during rollback"),
      { code: "08006" },
    );
    const harness = makeHarness({
      clientSteps: [
        ...creationPrefix(plan, { memberError: writeError }),
        { includes: "ROLLBACK", error: rollbackError },
      ],
    });
    const repository = new PgMarketplaceListingReplacementRepository(
      harness.pool,
    );

    const rejection = await repository.createOrReplayPlan(plan).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(rejection).toMatchObject({
      code: "MARKETPLACE_LISTING_REPLACEMENT_ROLLBACK_FAILED",
      context: {
        scopeId: plan.scopeId,
        persistenceErrorCode: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
        rollbackPostgresCode: "08006",
        rollbackConstraint: null,
      },
    });
    const aggregateCause = (rejection as Error & { cause?: unknown }).cause;
    expect(aggregateCause).toBeInstanceOf(AggregateError);
    expect((aggregateCause as AggregateError).errors).toEqual([
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REPLACEMENT_DATABASE_ERROR",
        context: expect.objectContaining({ postgresCode: "XX002" }),
      }),
      rollbackError,
    ]);
    expect(harness.release).toHaveBeenCalledWith(true);
    expect(harness.executedSql()).not.toContain("COMMIT");
    expect(harness.remainingClientSteps()).toBe(0);
  });
});

interface QueryStep {
  readonly includes: string;
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  readonly error?: unknown;
  readonly throws?: boolean;
  readonly values?: readonly unknown[];
}

function makeHarness(input: {
  readonly clientSteps?: readonly QueryStep[];
  readonly poolSteps?: readonly QueryStep[];
}): {
  readonly pool: Pool;
  readonly connect: ReturnType<typeof vi.fn>;
  readonly poolQuery: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly executedSql: () => readonly string[];
  readonly remainingClientSteps: () => number;
  readonly remainingPoolSteps: () => number;
} {
  const clientSteps = [...(input.clientSteps ?? [])];
  const poolSteps = [...(input.poolSteps ?? [])];
  const executed: string[] = [];
  const release = vi.fn();
  const clientQuery = vi.fn(async (query: unknown, values?: unknown[]) => {
    const sql = queryText(query);
    executed.push(normalizeSql(sql));
    return executeStep(clientSteps, sql, values);
  });
  const client = { query: clientQuery, release } as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const poolQuery = vi.fn(async (query: unknown, values?: unknown[]) => {
    return executeStep(poolSteps, queryText(query), values);
  });
  const pool = { connect, query: poolQuery } as unknown as Pool;
  return {
    pool,
    connect,
    poolQuery,
    release,
    executedSql: () => executed,
    remainingClientSteps: () => clientSteps.length,
    remainingPoolSteps: () => poolSteps.length,
  };
}

async function executeStep(
  steps: QueryStep[],
  sql: string,
  values?: unknown[],
): Promise<QueryResult<Record<string, unknown>>> {
  const step = steps.shift();
  if (!step) throw new Error(`Unexpected query: ${normalizeSql(sql)}`);
  expect(normalizeSql(sql)).toContain(normalizeSql(step.includes));
  if (step.values !== undefined) expect(values).toEqual(step.values);
  if (step.throws === true || step.error !== undefined) throw step.error;
  const rows = [...(step.rows ?? [])];
  return {
    command: "TEST",
    rowCount: step.rowCount ?? rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function queryText(query: unknown): string {
  if (typeof query === "string") return query;
  if (
    typeof query === "object" &&
    query !== null &&
    "text" in query &&
    typeof query.text === "string"
  ) {
    return query.text;
  }
  throw new Error("Test received an unsupported query shape.");
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function creationPrefix(
  plan: ListingReplacementPlan,
  failure: { readonly memberError?: unknown } = {},
): QueryStep[] {
  const prefix: QueryStep[] = [
    { includes: "BEGIN" },
    { includes: "SET LOCAL lock_timeout" },
    {
      includes: "FROM marketplace.listing_scopes",
      rows: [scopeRow()],
      values: [plan.scopeId],
    },
    {
      includes: "FROM marketplace.listing_replacement_operations",
      rows: [],
      values: [plan.scopeId, plan.idempotencyKey],
    },
    {
      includes: "FROM marketplace.listing_publications",
      rows: [sourcePublicationRow(plan)],
      values: [plan.sourcePublication.publicationId, plan.scopeId],
    },
    {
      includes: "SELECT COALESCE(MAX(generation), 0)",
      rows: [{ max_generation: 1 }],
      values: [plan.scopeId],
    },
    {
      includes: "INSERT INTO marketplace.listing_publications",
      rows: [{ id: 2002 }],
      values: targetPublicationInsertValues(plan),
    },
  ];
  prefix.push(
    failure.memberError === undefined
      ? {
          includes: "INSERT INTO marketplace.listing_publication_members",
          rowCount: plan.targetMembers.length,
          values: targetMemberInsertValues(plan),
        }
      : {
          includes: "INSERT INTO marketplace.listing_publication_members",
          error: failure.memberError,
          values: targetMemberInsertValues(plan),
        },
  );
  return prefix;
}

function persistedStepRows(
  plan: ListingReplacementPlan,
): Array<Record<string, unknown>> {
  return plan.steps.map((step, index) => ({
    id: 4001 + index,
    execution_path: step.executionPath,
    sequence: step.sequence,
    step_key: step.stepKey,
    phase: step.phase,
    state_version: 1,
  }));
}

function initialEventSteps(plan: ListingReplacementPlan): QueryStep[] {
  return [
    {
      includes: "'operation.planned'",
      rowCount: 1,
      values: [
        3001,
        plan.requestedBy.type,
        plan.requestedBy.id,
        JSON.stringify({
          planVersion: plan.planVersion,
          targetGeneration: plan.targetGeneration,
          requestedAt: plan.requestedAt.toISOString(),
        }),
      ],
    },
    ...plan.steps.map((step, index) => ({
      includes: "'step.pending'",
      rowCount: 1,
      values: [
        3001,
        index + 2,
        step.phase,
        4001 + index,
        plan.requestedBy.type,
        plan.requestedBy.id,
        JSON.stringify({
          executionPath: step.executionPath,
          requestHash: step.requestHash,
          sequence: step.sequence,
          stepKey: step.stepKey,
        }),
      ],
    })),
  ];
}

function targetPublicationInsertValues(
  plan: ListingReplacementPlan,
): unknown[] {
  return [
    plan.scopeId,
    plan.owner.productId,
    plan.targetGeneration,
    plan.sourcePublication.publicationId,
    plan.desiredStateHash,
    JSON.stringify({ planVersion: plan.planVersion }),
    plan.requestedBy.type,
    plan.requestedBy.id,
  ];
}

function targetMemberInsertValues(plan: ListingReplacementPlan): unknown[] {
  return [
    2002,
    plan.scopeId,
    plan.owner.productId,
    JSON.stringify(
      plan.targetMembers.map((member) => ({
        product_variant_id: member.productVariantId,
        sku_snapshot: member.skuSnapshot,
        disposition: member.disposition,
        reason_code: member.reasonCode,
      })),
    ),
  ];
}

function operationInsertValues(plan: ListingReplacementPlan): unknown[] {
  return [
    plan.scopeId,
    plan.sourcePublication.publicationId,
    2002,
    plan.idempotencyKey,
    plan.requestHash,
    plan.desiredStateHash,
    plan.requestedBy.type,
    plan.requestedBy.id,
    plan.correlationId,
  ];
}

function stepInsertValues(plan: ListingReplacementPlan): unknown[] {
  return [
    3001,
    JSON.stringify(
      plan.steps.map((step) => ({
        execution_path: step.executionPath,
        sequence: step.sequence,
        step_key: step.stepKey,
        phase: step.phase,
        idempotency_key: step.idempotencyKey,
        request_hash: step.requestHash,
        attempt_limit: step.attemptLimit,
        request_payload: step.requestPayload,
      })),
    ),
  ];
}

function replacementPlan(): ListingReplacementPlan {
  return buildListingReplacementPlan({
    snapshot: {
      owner: {
        kind: "channel",
        channelId: 7,
        productId: 33,
        provider: "ebay",
        marketplaceId: "EBAY_US",
      },
      scopeId: 51,
      sourcePublication: {
        publicationId: 1001,
        generation: 1,
        status: "active",
        desiredStateHash: "a".repeat(64),
        providerPublicationKey: "ARM-ENV-SGL",
        externalListingId: "298148438778",
      },
      nextGeneration: 2,
      memberCandidates: [
        {
          productVariantId: 438,
          sku: "ARM-ENV-SGL-C750",
          currentlyPublished: true,
        },
      ],
    },
    requestedMembers: [
      { productVariantId: 438, disposition: "included", reasonCode: null },
    ],
    idempotencyKey: "replace-arm-env-sgl-2026-08-04",
    requestedBy: { type: "user", id: "owner@example.test" },
    correlationId: "repository-test",
    requestedAt: new Date("2026-08-04T12:00:00.000Z"),
  });
}

function replayLookup(
  plan: ListingReplacementPlan,
): ListingReplacementReplayLookup {
  return {
    owner: plan.owner,
    idempotencyKey: plan.idempotencyKey,
    requestHash: plan.requestHash,
  };
}

function scopeRow(): Record<string, unknown> {
  return {
    id: 51,
    owner_kind: "channel",
    provider: "ebay",
    marketplace_id: "EBAY_US",
    product_id: 33,
    channel_id: 7,
    store_connection_id: null,
  };
}

function sourcePublicationRow(
  plan: ListingReplacementPlan,
): Record<string, unknown> {
  return {
    id: plan.sourcePublication.publicationId,
    generation: plan.sourcePublication.generation,
    status: "active",
    desired_state_hash: plan.sourcePublication.desiredStateHash,
    provider_publication_key: plan.sourcePublication.providerPublicationKey,
    external_listing_id: plan.sourcePublication.externalListingId,
  };
}

function operationRow(plan: ListingReplacementPlan): Record<string, unknown> {
  return {
    id: 3001,
    scope_id: plan.scopeId,
    source_publication_id: plan.sourcePublication.publicationId,
    target_publication_id: 2002,
    idempotency_key: plan.idempotencyKey,
    request_hash: plan.requestHash,
    desired_state_hash: plan.desiredStateHash,
    status: "planned",
    current_phase: "preflight",
    state_version: 1,
    created_at: new Date("2026-08-04T12:00:00.000Z"),
    updated_at: new Date("2026-08-04T12:00:00.000Z"),
  };
}
