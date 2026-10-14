/** Explicit empty-custody query prerequisite for unrelated inventory suites.
 * The actual migration and transaction fence are exercised separately by
 * receiving-custody-count-guard.integration.test.ts. Callers own their schemas
 * and existing catalog variant identities; this does not replace either owner.
 */
export const emptyReceivingCustodyFixtureSql = `
  CREATE TABLE procurement.receiving_custody_fence (
    singleton boolean PRIMARY KEY CHECK(singleton),
    revision bigint NOT NULL DEFAULT 0 CHECK(revision >= 0)
  );
  INSERT INTO procurement.receiving_custody_fence(singleton,revision) VALUES(true,0);
  CREATE TABLE procurement.receiving_quarantine_observations (
    id integer PRIMARY KEY, receiving_order_id integer NOT NULL,
    holding_location_id integer NOT NULL, product_id integer,
    observed_qty integer NOT NULL, received_qty integer NOT NULL,
    returned_qty integer NOT NULL
  );
`;
