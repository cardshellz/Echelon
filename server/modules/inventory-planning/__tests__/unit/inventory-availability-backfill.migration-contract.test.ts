import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = source("migrations/0622_inventory_availability_backfill_review.sql");
const backfillRepository = source(
  "server/modules/inventory-planning/infrastructure/inventory-availability-backfill.repository.ts",
);
const previewRepository = source(
  "server/modules/inventory-planning/infrastructure/inventory-availability-channel-preview.repository.ts",
);
const routes = source(
  "server/modules/inventory-planning/interfaces/http/inventory-availability-backfill.routes.ts",
);
const command = source("scripts/backfill-inventory-availability-models.ts");

describe("inventory availability Phase 3 isolation contract", () => {
  it("adds only draft provenance and append-only review evidence", () => {
    expect(migration).toContain("ADD COLUMN origin");
    expect(migration).toContain("CREATE TABLE inventory.transformation_model_reviews");
    expect(migration).toContain("transformation_model_versions_origin_guard");
    expect(migration).toContain("transformation_model_reviews_append_only_guard");
    expect(migration).toContain("transformation_model_reviews_current_draft_guard");
    expect(migration).toContain("transformation_model_versions_review_evidence_uq");
    expect(migration).toContain(
      "FOREIGN KEY (model_id, product_id, model_version, model_definition_hash)",
    );
    expect(migration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:inventory\.inventory_levels|inventory\.inventory_transactions|wms\.|channels\.)/i,
    );
    expect(migration).not.toMatch(/\b(?:activation|outbox|publication)_/i);
  });

  it("keeps capture and channel calculation inside read-only transactions", () => {
    expect(backfillRepository).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(previewRepository).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(previewRepository).toContain(".previewProduct(productId)");
    expect(previewRepository).not.toContain("allocateProduct(productId)");
    expect(previewRepository).not.toMatch(/adapter\.(?:sync|publish|push|set)/i);
  });

  it("gates draft, refresh, and review writes by the inventory-planning edit ability", () => {
    expect(routes.match(/requirePermission\("inventory_planning", "view"\)/g)).toHaveLength(2);
    expect(routes.match(/requirePermission\("inventory_planning", "edit"\)/g)).toHaveLength(3);
    expect(routes).not.toMatch(/activate|publish|reservation|inventory-level/i);
  });

  it("keeps stale-draft refresh behind an explicit apply-only command flag", () => {
    expect(command).toContain('"--refresh-stale-drafts"');
    expect(command).toContain("--refresh-stale-drafts requires --apply");
    expect(command).toContain('product.draft?.origin === "phase3_backfill"');
    expect(command).toContain("service.refreshProductDraft(");
    expect(command).toContain("runtimeAuthorityChanged: false");
    expect(command).toContain("inventoryWriteAttempted: false");
    expect(command).toContain("channelWriteAttempted: false");
  });
});
