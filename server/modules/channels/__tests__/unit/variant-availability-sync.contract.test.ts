import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repoFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("inactive variant availability contracts", () => {
  it("captures both catalog transitions and late-created eBay mappings durably", () => {
    const migration = repoFile("migrations/0606_channel_variant_availability_sync.sql");

    expect(migration).toContain("AFTER UPDATE OF is_active ON catalog.product_variants");
    expect(migration).toContain("channel_feeds_enqueue_availability_sync_insert");
    expect(migration).toContain("channel_listings_enqueue_availability_sync_insert");
    expect(migration).toContain("WHERE variant_row.is_active = FALSE");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).not.toContain("status = 'dead'");
    expect(migration).not.toContain("max_attempts");
  });

  it("preserves inventory, bins, and listing mappings during a normal archive", () => {
    const routes = repoFile("server/modules/catalog/catalog.routes.ts");
    const productArchive = routes.slice(
      routes.indexOf('app.post("/api/products/:id/archive"'),
      routes.indexOf('app.delete("/api/products/:id"'),
    );
    const variantArchive = routes.slice(
      routes.indexOf('app.post("/api/product-variants/:id/archive"'),
      routes.indexOf('app.delete("/api/product-variants/:id"'),
    );

    for (const archiveHandler of [productArchive, variantArchive]) {
      expect(archiveHandler).not.toContain("DELETE FROM channels.channel_listings");
      expect(archiveHandler).not.toContain("inventory zeroed");
      expect(archiveHandler).toContain("if (transferToVariantId)");
      expect(archiveHandler).toContain("inventoryPreserved");
    }
  });

  it("uses a lease and row locking so multiple app instances cannot own the same transition", () => {
    const repository = repoFile(
      "server/modules/channels/variant-availability-sync.repository.ts",
    );

    expect(repository).toContain("FOR UPDATE SKIP LOCKED");
    expect(repository).toContain("lease_token = $2::uuid");
    expect(repository).toContain("AND lease_token = $4::uuid");
    expect(repository).toContain("ON CONFLICT (channel_id, product_variant_id)");
  });
});
