/**
 * Reduced query fixture for OMS ingestion suites whose orders have no edits.
 * The real ingress guard must query an empty projection table rather than being
 * mocked or bypassed. Full migration constraints and edited-order behavior are
 * exercised by order-edit-warehouse.integration.test.ts.
 */
export const orderEditProjectionQueryFixtureSql = `
  CREATE TABLE oms.order_edit_paid_projections (
    oms_order_id bigint PRIMARY KEY,
    operation_id uuid NOT NULL,
    source_updated_at timestamptz NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    projected_at timestamptz NOT NULL
  );
`;
