/**
 * PR C's end request table (PLAN-C v4.1 §3), reduced, for the suites that build Dropship from reduced fixtures
 * (no rule set revisions, no 0743 functions) and run code that reads the table since C2: the shared stock
 * listing SQL, the push fence, the sweep and its health copy, the catch-up and the order candidates (§6-§9),
 * and since C4 the end worker's ops-health checks (§5.7). Only the columns those readers name, the state and
 * end-time checks and the one-open-end index, as the real migration has them; the columns only the health
 * checks read are nullable or defaulted here, so a reader suite still inserts just (listing_id, state). The real migration, its keys and its triggers run in
 * dropship-listing-end.integration.test.ts and dropship-listing-end-interplay.integration.test.ts. IF NOT EXISTS,
 * so fixtures that share it may each install it; a suite that also applies the real migration fails loudly.
 */
export const LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL = `
  CREATE TABLE IF NOT EXISTS dropship.dropship_listing_end_requests (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    listing_id integer NOT NULL, state varchar(20) NOT NULL, ended_at timestamptz,
    vendor_id integer, store_connection_id integer, product_variant_id integer, code varchar(100),
    context jsonb NOT NULL DEFAULT '{}'::jsonb, deferral_count integer NOT NULL DEFAULT 0, decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_end_state_chk CHECK (state IN ('pending','ending','ended','failed','superseded','resolved')),
    CONSTRAINT dropship_end_ended_at_chk CHECK ((state = 'ended') = (ended_at IS NOT NULL)));
  CREATE UNIQUE INDEX IF NOT EXISTS dropship_end_one_open_idx ON dropship.dropship_listing_end_requests (listing_id)
    WHERE state IN ('pending','ending','failed');
`;
