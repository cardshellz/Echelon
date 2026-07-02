import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

const ACCEPTANCE_REPOSITORY_SRC = readSource(
  "../../infrastructure/dropship-order-acceptance.repository.ts",
);

describe("PgDropshipOrderAcceptanceRepository", () => {
  it("stamps accepted OMS order lines as dropship-owned", () => {
    const insertBlock = sourceBlock(
      ACCEPTANCE_REPOSITORY_SRC,
      "INSERT INTO oms.oms_order_lines",
      "RETURNING id, product_variant_id, quantity",
    );

    expect(insertBlock).toContain("fulfillment_provider");
    expect(insertBlock).toContain("'dropship', 'unfulfilled'");
  });
});
