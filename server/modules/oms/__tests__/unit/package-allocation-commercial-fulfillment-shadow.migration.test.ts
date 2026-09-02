import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0640_package_allocation_commercial_fulfillment_shadow.sql"),
  "utf8",
);
const schema = readFileSync(
  resolve(process.cwd(), "shared/schema/fulfillment.schema.ts"),
  "utf8",
);
const repository = readFileSync(
  resolve(process.cwd(), "server/modules/oms/channel-fulfillment-authority.repository.ts"),
  "utf8",
);
const integrationSchema = readFileSync(
  resolve(process.cwd(), "test/fixtures/named-schema-integration.sql"),
  "utf8",
);
const integrationSetup = readFileSync(
  resolve(process.cwd(), "test/setup-integration.ts"),
  "utf8",
);

describe("package-allocation commercial fulfillment shadow migration", () => {
  it("adds an explicitly non-dispatching canonical command state", () => {
    expect(migration).toMatch(
      /channel_fulfillment_pushes_status_chk[\s\S]*'shadow'[\s\S]*'pending'/,
    );
    expect(migration).toContain(
      "OLD.push_status = 'shadow' AND NEW.push_status NOT IN ('shadow', 'pending', 'review', 'dead')",
    );
    expect(schema).toMatch(
      /channelFulfillmentPushStatusValues = \[[\s\S]*"shadow",[\s\S]*"pending"/,
    );
    expect(repository).toContain("'shadow',");
    expect(repository).toContain("pushStatus: \"shadow\"");
  });

  it("binds every shadow command item to exact commercial and physical evidence", () => {
    expect(migration).toContain("ADD COLUMN package_allocation_effect_intent_id BIGINT");
    expect(migration).toContain("REFERENCES wms.package_allocation_effect_intents(id)");
    expect(migration).toContain("validate_package_allocation_commercial_fulfillment_item");
    expect(migration).toContain("intent.effect_type <> 'commercial_fulfillment'");
    expect(migration).toContain("lineage.allocation_kind <> 'primary_transfer'");
    expect(migration).toContain("lineage.target_kind <> 'package'");
    expect(migration).toContain("lineage.package_allocation_plan_id IS DISTINCT FROM intent.package_allocation_plan_id");
    expect(migration).toContain("NEW.quantity_pushed IS DISTINCT FROM lineage.physical_quantity");
    expect(migration).toContain("already_materialized + NEW.quantity_pushed > intent.quantity");
    expect(migration).toContain("USING ERRCODE = '23514'");
    expect(schema).toContain(
      'packageAllocationEffectIntentId: bigint("package_allocation_effect_intent_id"',
    );
  });

  it("keeps the existing worker claim predicate limited to pending and retry", () => {
    expect(schema).toContain("${table.pushStatus} IN ('pending', 'retry')");
    expect(repository).toContain("push_status IN ('pending', 'retry')");
    expect(repository).not.toMatch(/push_status IN \('shadow',[ ]*'pending',[ ]*'retry'\)/);
  });

  it("rebuilds the OMS schema before applying the canonical fulfillment fixture", () => {
    expect(integrationSchema).toContain("DROP SCHEMA IF EXISTS oms CASCADE");
    expect(integrationSchema).toContain("CREATE SCHEMA oms");

    const baseSchemaIndex = integrationSetup.indexOf(
      '"test/fixtures/named-schema-integration.sql"',
    );
    const fulfillmentFixtureIndex = integrationSetup.indexOf(
      '"test/fixtures/channel-fulfillment-package-allocation-integration.sql"',
    );
    const migrationIndex = integrationSetup.indexOf(
      '"migrations/0640_package_allocation_commercial_fulfillment_shadow.sql"',
    );
    expect(baseSchemaIndex).toBeGreaterThanOrEqual(0);
    expect(fulfillmentFixtureIndex).toBeGreaterThan(baseSchemaIndex);
    expect(migrationIndex).toBeGreaterThan(fulfillmentFixtureIndex);
  });
});
