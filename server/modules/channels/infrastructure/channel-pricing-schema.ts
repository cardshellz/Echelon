/**
 * Production pricing-rule DDL, shared by startup and PostgreSQL regressions.
 * These are two partial indexes: conflict inference must include their exact
 * null/non-null predicates. Do not replace them with an unconditional test index.
 */
export const CHANNEL_PRICING_RULES_DDL = `
  CREATE TABLE IF NOT EXISTS channels.channel_pricing_rules (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    scope VARCHAR(20) NOT NULL,
    scope_id VARCHAR(100),
    rule_type VARCHAR(20) NOT NULL,
    value NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cpr_channel_scope_scopeid
    ON channels.channel_pricing_rules(channel_id, scope, scope_id) WHERE scope_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_cpr_channel_scope_null
    ON channels.channel_pricing_rules(channel_id, scope) WHERE scope_id IS NULL;
`;
