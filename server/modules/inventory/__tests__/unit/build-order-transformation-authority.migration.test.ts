import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0668_build_order_transformation_authority.sql"),
  "utf8",
);
const schema = fs.readFileSync(
  path.resolve(process.cwd(), "shared/schema/inventory.schema.ts"),
  "utf8",
);
const modelReviewMigration = fs.readFileSync(
  path.resolve(process.cwd(), "migrations/0622_inventory_availability_backfill_review.sql"),
  "utf8",
);

describe("build-order transformation authority migration", () => {
  it("adds immutable nullable legacy or complete canonical evidence without activating runtime", () => {
    expect(migration).toContain("ADD COLUMN transformation_authority VARCHAR(20)");
    expect(migration).toContain("build_orders_transformation_authority_chk");
    expect(migration).toContain("transformation_authority = 'canonical'");
    expect(migration).toContain("canonical build transformation authority evidence is immutable");
    expect(migration).toContain("build_orders_transformation_model_fk");
    expect(migration).toContain("build_orders_transformation_binding_fk");
    expect(migration).toContain("CREATE UNIQUE INDEX transformation_recipe_bindings_build_evidence_uq");
    expect(migration).toMatch(
      /FOREIGN KEY \(\s*transformation_recipe_binding_id,\s*transformation_model_id,\s*recipe_id,\s*transformation_recipe_definition_hash\s*\)/,
    );
    expect(modelReviewMigration).toContain("CREATE UNIQUE INDEX transformation_model_versions_review_evidence_uq");
    expect(modelReviewMigration).toContain("ON inventory.transformation_model_versions(id, product_id, version, definition_hash)");
    expect(migration).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\.(?:inventory_levels|inventory_lots)/i);
  });

  it("keeps the Drizzle schema aligned with every durable evidence field", () => {
    for (const field of [
      "transformationAuthority",
      "transformationAuthorityRevision",
      "transformationActivationRunId",
      "transformationModelHeadRevision",
      "transformationModelId",
      "transformationModelVersion",
      "transformationModelDefinitionHash",
      "transformationRecipeBindingId",
      "transformationRecipeDefinitionHash",
      "transformationAuthorizedAt",
      "transformationAuthorizedBy",
    ]) {
      expect(schema).toContain(`${field}:`);
    }
  });
});
