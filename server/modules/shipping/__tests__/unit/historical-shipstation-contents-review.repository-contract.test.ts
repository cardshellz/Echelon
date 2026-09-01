import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repositorySource = readFileSync(
  join(here, "..", "..", "historical-shipstation-contents-review.repository.ts"),
  "utf8",
);

describe("historical ShipStation contents review repository SQL contract", () => {
  it("gives polymorphic JSON builder parameters explicit PostgreSQL types", () => {
    const decisionStart = repositorySource.indexOf(
      "const history = persistedRecord.decisionHistory ?? [];",
    );
    const updateStart = repositorySource.indexOf(
      "UPDATE wms.reconciliation_exceptions",
      decisionStart,
    );
    const updateEnd = repositorySource.indexOf(
      "RETURNING id::text AS id, status",
      updateStart,
    );
    const decisionUpdate = repositorySource.slice(updateStart, updateEnd);

    expect(decisionStart).toBeGreaterThan(-1);
    expect(updateStart).toBeGreaterThan(decisionStart);
    expect(updateEnd).toBeGreaterThan(updateStart);
    expect(decisionUpdate).toContain("$5::jsonb || jsonb_build_object(");
    expect(decisionUpdate).toContain("'decisionHash', $6::text");
  });
});
