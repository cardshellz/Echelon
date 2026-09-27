/** Reduced EMPTY lifecycle lookup for isolated shipment-query suites. Actual
 * audit DDL, admission, FK/immutability and retirement writes are exercised by
 * inventory-cutover-history.integration.test.ts, not this fixture. */
export const historyRetirementLookupFixtureSql = `CREATE TABLE inventory.cutover_history_retirements(
  batch_id bigint NOT NULL, receipt_id bigint UNIQUE, shipment_id integer UNIQUE,
  decision_payload jsonb NOT NULL DEFAULT '{"sourceItemIds":[]}'::jsonb
);`;
