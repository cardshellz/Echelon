import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { LATEST_PUBLICATION_ROW_SQL } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { parseFlags } from "../../../../../scripts/repair-historical-carrier-dispatch";

// 2026-10-05: the latest-revision read ordered by an unqualified name that
// Postgres resolved to the text alias, so "9" sorted above "10". Every
// target/variant pair that reached revision 10 then re-inserted 10 and the
// outbox guard refused it: pick follow-ups (replen) and carrier dispatch
// (tracking to Shopify) failed with "publication revision must be greater than
// existing revision 10". The PostgreSQL proof lives in
// inventory-availability-foundation.integration.test.ts.

describe("latest publication revision read", () => {
  it("orders by the numeric table column, never the text alias", () => {
    expect(LATEST_PUBLICATION_ROW_SQL).toMatch(/FROM inventory\.inventory_publication_outbox outbox/);
    expect(LATEST_PUBLICATION_ROW_SQL).toMatch(/ORDER BY outbox\.desired_revision DESC/);
    expect(LATEST_PUBLICATION_ROW_SQL).not.toMatch(/ORDER BY desired_revision/);
  });

  it("is the read the publication executor runs", () => {
    const source = readFileSync(resolve(process.cwd(),
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-publication.repository.ts"), "utf8");
    expect(source).toMatch(/LATEST_PUBLICATION_ROW_SQL,\s+\[intent\.publicationTargetId, intent\.productVariantId\],/);
  });

  it("breaks claim revision ties by the numeric id, not its text alias", () => {
    const source = readFileSync(resolve(process.cwd(),
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-claim.repository.ts"), "utf8");
    expect(source).toContain("ORDER BY claim.revision DESC, claim.id DESC");
    expect(source).not.toContain("ORDER BY revision DESC, id DESC");
  });
});

describe("parked carrier dispatches from the revision bug", () => {
  const repository = readFileSync(resolve(process.cwd(), "server/modules/shipping/carrier-tracking.repository.ts"), "utf8");

  it("are a reviewed repair cohort that the requeue may select", () => {
    expect(repository).toContain("THEN 'publication_revision_order'");
    expect(repository).toContain("'^publication revision must be greater than existing revision [0-9]+$'");
    const eligibility = repository.slice(repository.indexOf("function historicalCarrierDispatchRepairEligibilitySql"));
    expect(eligibility.slice(0, eligibility.indexOf("OR ("))).toContain("'publication_revision_order'");
  });

  it("can be selected by the operator repair script", () => {
    expect(parseFlags(["--cohort=publication_revision_order"]).cohort).toBe("publication_revision_order");
  });
});
