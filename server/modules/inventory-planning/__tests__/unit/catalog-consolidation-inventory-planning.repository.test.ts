import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  CatalogConsolidationInventoryPlanningError,
  type CatalogConsolidationInventoryPlanningTransaction,
} from "../../application/catalog-consolidation-inventory-planning.port";
import {
  PostgresCatalogConsolidationInventoryPlanningRepository,
} from "../../infrastructure/catalog-consolidation-inventory-planning.repository";

const dialect = new PgDialect();

function compile(query: SQL) {
  return dialect.sqlToQuery(query);
}

function clientFrom(
  execute: (query: SQL) => Promise<unknown>,
): CatalogConsolidationInventoryPlanningTransaction {
  return { execute };
}

describe("PostgresCatalogConsolidationInventoryPlanningRepository", () => {
  it("loads a complete typed dependency snapshot from owner tables", async () => {
    const execute = vi.fn(async (query: SQL) => {
      const statement = compile(query).sql;
      if (statement.includes("requested.variant_id")) {
        return {
          rows: [{
            variant_id: 78,
            active_claim_count: 2,
            open_planning_work_reference_count: 3,
            non_draft_transformation_reference_count: 4,
            channel_exposure_policy_version_count: 5,
            transformation_recipe_binding_count: 6,
            transformation_recipe_component_snapshot_count: 7,
          }],
        };
      }
      if (statement.includes("requested.product_id")) {
        return {
          rows: [
            {
              product_id: 39,
              active_model_id: null,
              draft_model_id: 227,
              active_channel_exposure_policy_count: 0,
            },
            {
              product_id: 103,
              active_model_id: null,
              draft_model_id: 285,
              active_channel_exposure_policy_count: 1,
            },
          ],
        };
      }
      if (statement.includes("availability_activation_freezes")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${statement}`);
    });
    const repository = new PostgresCatalogConsolidationInventoryPlanningRepository();

    await expect(repository.loadEvidence({
      client: clientFrom(execute),
      productIds: [103, 39],
      variants: [{ variantId: 78, productId: 39 }],
    })).resolves.toEqual({
      activeCutoverFreezeId: null,
      products: [
        {
          productId: 39,
          activeTransformationModelId: null,
          draftTransformationModelId: 227,
          activeChannelExposurePolicyCount: 0,
        },
        {
          productId: 103,
          activeTransformationModelId: null,
          draftTransformationModelId: 285,
          activeChannelExposurePolicyCount: 1,
        },
      ],
      variants: [{
        variantId: 78,
        activeClaimCount: 2,
        openPlanningWorkReferenceCount: 3,
        nonDraftTransformationReferenceCount: 4,
        channelExposurePolicyVersionCount: 5,
        transformationRecipeBindingCount: 6,
        transformationRecipeComponentSnapshotCount: 7,
      }],
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("locks product identities in ascending order and owns the planning table fence", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const client = clientFrom(execute);
    const repository = new PostgresCatalogConsolidationInventoryPlanningRepository();

    await repository.lockProducts({ client, productIds: [103, 39, 103] });
    await repository.fenceDependencies({ client });

    const calls = execute.mock.calls.map(([query]) => compile(query));
    expect(calls[0].params).toEqual([918422, 39]);
    expect(calls[1].params).toEqual([918422, 103]);
    expect(calls[2].sql).toContain("LOCK TABLE");
    expect(calls[2].sql).toContain("inventory.transformation_model_heads");
    expect(calls[2].sql).toContain("inventory.inventory_publication_outbox");
  });

  it("supersedes and replaces an expected draft inside the caller transaction", async () => {
    const statements: ReturnType<typeof compile>[] = [];
    const execute = vi.fn(async (query: SQL) => {
      const statement = compile(query);
      statements.push(statement);
      const normalized = statement.sql.toLowerCase();
      if (normalized.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (normalized.includes("update inventory.transformation_model_versions")) {
        return { rows: [{ id: 227, version: 1 }] };
      }
      if (normalized.includes("insert into inventory.transformation_model_versions")) {
        return { rows: [{ id: 1_000 }] };
      }
      if (normalized.includes("update inventory.transformation_model_heads")) {
        return { rows: [{ product_id: 39 }] };
      }
      throw new Error(`Unexpected SQL: ${statement.sql}`);
    });
    const repository = new PostgresCatalogConsolidationInventoryPlanningRepository();

    await expect(repository.invalidateDrafts({
      client: clientFrom(execute),
      expectedDrafts: [{ productId: 39, draftModelId: 227 }],
      canonicalProductId: 103,
      externalProductId: "9001",
      requestHash: "a".repeat(64),
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      actor: "user:test",
      reason: "Consolidate the reviewed product family",
      occurredAt: new Date("2026-09-12T20:00:00.000Z"),
    })).resolves.toEqual({
      invalidatedModelIds: [227],
      replacementModelIds: [1_000],
    });
    expect(statements.map((statement) => statement.sql.toLowerCase())).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("update inventory.transformation_model_versions"),
      expect.stringContaining("insert into inventory.transformation_model_versions"),
      expect.stringContaining("update inventory.transformation_model_heads"),
    ]);
    const insert = statements[2];
    expect(insert.params).toContain("shopify-consolidation:123e4567-e89b-42d3-a456-426614174000:39");
    expect(insert.params).toContain("user:test");
  });

  it("fails closed when the reviewed draft is stale", async () => {
    const execute = vi.fn(async (_query: SQL) => ({ rows: [] }));
    const repository = new PostgresCatalogConsolidationInventoryPlanningRepository();

    await expect(repository.invalidateDrafts({
      client: clientFrom(execute),
      expectedDrafts: [{ productId: 39, draftModelId: 227 }],
      canonicalProductId: 103,
      externalProductId: "9001",
      requestHash: "a".repeat(64),
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174000",
      actor: "user:test",
      reason: "Consolidate the reviewed product family",
      occurredAt: new Date("2026-09-12T20:00:00.000Z"),
    })).rejects.toMatchObject<Partial<CatalogConsolidationInventoryPlanningError>>({
      code: "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_STALE",
    });
  });
});
