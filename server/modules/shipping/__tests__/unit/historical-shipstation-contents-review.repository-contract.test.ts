import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repositorySource = readFileSync(
  join(here, "..", "..", "historical-shipstation-contents-review.repository.ts"),
  "utf8",
);
const omsMutationsSource = readFileSync(
  join(here, "..", "..", "..", "oms", "reconciliation-exceptions-mutations.repository.ts"),
  "utf8",
);

describe("historical ShipStation contents review repository SQL contract", () => {
  it("gives polymorphic JSON builder parameters explicit PostgreSQL types", () => {
    const decisionStart = repositorySource.indexOf(
      "const history = persistedRecord.decisionHistory ?? [];",
    );
    const delegateCall = repositorySource.indexOf(
      "acknowledgeHistoricalContentsReconciliationExceptionDecisionInTx(",
      decisionStart,
    );

    expect(decisionStart).toBeGreaterThan(-1);
    expect(delegateCall).toBeGreaterThan(decisionStart);

    const fnStart = omsMutationsSource.indexOf(
      "export async function acknowledgeHistoricalContentsReconciliationExceptionDecisionInTx(",
    );
    const updateStart = omsMutationsSource.indexOf(
      "UPDATE wms.reconciliation_exceptions",
      fnStart,
    );
    const updateEnd = omsMutationsSource.indexOf(
      "RETURNING id::text AS id, status",
      updateStart,
    );
    const decisionUpdate = omsMutationsSource.slice(updateStart, updateEnd);

    expect(fnStart).toBeGreaterThan(-1);
    expect(updateStart).toBeGreaterThan(fnStart);
    expect(updateEnd).toBeGreaterThan(updateStart);
    expect(decisionUpdate).toContain("$5::jsonb || jsonb_build_object(");
    expect(decisionUpdate).toContain("'decisionHash', $6::text");
  });
});
