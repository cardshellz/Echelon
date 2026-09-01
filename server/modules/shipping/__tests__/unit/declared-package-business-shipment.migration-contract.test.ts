import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8")
    .replace(/\r\n/g, "\n");
}

const migration = source(
  "migrations",
  "0637_declared_package_business_shipments.sql",
);
const schema = source("shared", "schema", "fulfillment.schema.ts");
const carrierDomain = source(
  "server",
  "modules",
  "shipping",
  "carrier-tracking.domain.ts",
);
const carrierRepository = source(
  "server",
  "modules",
  "shipping",
  "carrier-tracking.repository.ts",
);
const shipStationService = source(
  "server",
  "modules",
  "oms",
  "shipstation.service.ts",
);
const integrationSetup = source("test", "setup-integration.ts");
const normalizedMigration = migration.replace(/\s+/g, " ").trim();

describe("declared package business-shipment migration contract", () => {
  it("stores one append-only fact with exact label-event lineage", () => {
    expect(normalizedMigration).toContain(
      "CREATE TABLE wms.declared_package_business_shipments",
    );
    expect(normalizedMigration).toContain(
      "UNIQUE (shipping_provider_label_id)",
    );
    expect(normalizedMigration).toContain("UNIQUE (recognition_event_id)");
    expect(normalizedMigration).toContain(
      "FOREIGN KEY (recognition_event_id, shipping_provider_label_id) REFERENCES wms.shipping_provider_label_events(id, shipping_provider_label_id)",
    );
    expect(normalizedMigration).toContain(
      "BEFORE UPDATE OR DELETE ON wms.declared_package_business_shipments",
    );
    expect(schema).toContain(
      'export const declaredPackageBusinessShipments = wmsSchema.table(',
    );
    expect(schema).toContain(
      '"fk_declared_package_business_shipments_event_label"',
    );
  });

  it("recognizes only explicit outbound label observations", () => {
    expect(normalizedMigration).toContain(
      "NEW.event_type <> 'label_observed'",
    );
    expect(normalizedMigration).toContain(
      "NEW.sanitized_payload->'isReturnLabel' IS DISTINCT FROM 'false'::jsonb",
    );
    expect(normalizedMigration).toContain(
      "persisted_label_direction <> 'outbound'",
    );
    expect(normalizedMigration).toContain(
      "AFTER INSERT ON wms.shipping_provider_label_events",
    );
    expect(carrierDomain).toContain(
      "isReturnLabel: shipment.isReturnLabel",
    );
    expect(carrierRepository).toContain(
      ".insert(shippingProviderLabelEvents)",
    );
    const processStart = shipStationService.indexOf(
      "async function processShipNotify(resourceUrl: string)",
    );
    const directionHydration = shipStationService.indexOf(
      "await hydrateReturnLabelDirection(shipment)",
      processStart,
    );
    const observation = shipStationService.indexOf(
      "await observeProviderLabel(detailedShipment)",
      directionHydration,
    );
    expect(processStart).toBeGreaterThan(-1);
    expect(directionHydration).toBeGreaterThan(processStart);
    expect(observation).toBeGreaterThan(directionHydration);
  });

  it("does not infer historical shipment authority", () => {
    expect(migration).toContain(
      "Existing labels are intentionally not backfilled",
    );
    expect(normalizedMigration).not.toContain(
      "FROM wms.shipping_provider_label_events AS historical_event",
    );
  });

  it("installs and truncates the fact in the disposable PostgreSQL harness", () => {
    expect(integrationSetup).toContain(
      '"migrations/0637_declared_package_business_shipments.sql"',
    );
    expect(integrationSetup.indexOf(
      '"wms.declared_package_business_shipments"',
    )).toBeLessThan(integrationSetup.indexOf(
      '"wms.shipping_provider_labels"',
    ));
  });
});
