import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0607_marketplace_listing_replacement_foundation.sql",
  ),
  "utf8",
);

const compactMigration = migrationSql.replace(/\s+/g, " ").trim();

function expectSql(fragment: string): void {
  expect(compactMigration).toContain(fragment.replace(/\s+/g, " ").trim());
}

function compactSql(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

function functionBody(functionName: string): string {
  const header = `CREATE OR REPLACE FUNCTION marketplace.${functionName}()`;
  const functionStart = migrationSql.indexOf(header);
  if (functionStart < 0) {
    throw new Error(`Migration is missing function ${functionName}`);
  }
  const bodyStart = migrationSql.indexOf("AS $$", functionStart);
  const bodyEnd = migrationSql.indexOf("$$;", bodyStart + 5);
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error(
      `Migration has an incomplete body for function ${functionName}`,
    );
  }
  return migrationSql.slice(bodyStart + 5, bodyEnd);
}

describe("marketplace listing replacement migration contract", () => {
  it("creates only the eight canonical marketplace listing tables", () => {
    const tableNames = [
      ...migrationSql.matchAll(/CREATE TABLE marketplace\.([a-z_]+)\s*\(/g),
    ].map((match) => match[1]);

    expect(tableNames).toEqual([
      "listing_scopes",
      "channel_listing_scopes",
      "dropship_listing_scopes",
      "listing_publications",
      "listing_publication_members",
      "listing_replacement_operations",
      "listing_replacement_steps",
      "listing_replacement_events",
    ]);
  });

  it("requires one matching channel or dropship owner binding per scope", () => {
    expectSql(`
      CONSTRAINT channel_listing_scopes_scope_product_fk
      FOREIGN KEY (scope_id, product_id)
      REFERENCES marketplace.listing_scopes(id, product_id) ON DELETE RESTRICT
    `);
    expectSql(`
      CONSTRAINT dropship_listing_scopes_scope_product_fk
      FOREIGN KEY (scope_id, product_id)
      REFERENCES marketplace.listing_scopes(id, product_id) ON DELETE RESTRICT
    `);
    expectSql(`
      CREATE CONSTRAINT TRIGGER listing_scopes_owner_binding_required
      AFTER INSERT ON marketplace.listing_scopes
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql(`
      CREATE CONSTRAINT TRIGGER channel_listing_scopes_owner_binding_required
      AFTER INSERT ON marketplace.channel_listing_scopes
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql(`
      CREATE CONSTRAINT TRIGGER dropship_listing_scopes_owner_binding_required
      AFTER INSERT ON marketplace.dropship_listing_scopes
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql("scope_row.owner_kind IS DISTINCT FROM 'channel'");
    expectSql("scope_row.provider IS DISTINCT FROM channel_provider");
    expectSql("scope_row.owner_kind IS DISTINCT FROM 'dropship'");
    expectSql("scope_row.provider IS DISTINCT FROM store_provider");
    expectSql("must have exactly one matching owner binding");

    const ownerBindingGuard = compactSql(
      functionBody("enforce_listing_scope_owner_binding"),
    );
    expect(ownerBindingGuard).toContain(
      "IF TG_TABLE_NAME = 'listing_scopes' THEN target_scope_id := NEW.id; ELSE target_scope_id := NEW.scope_id; END IF;",
    );
    expect(ownerBindingGuard).not.toContain(
      "CASE WHEN TG_TABLE_NAME = 'listing_scopes' THEN NEW.id ELSE NEW.scope_id END",
    );
  });

  it("preserves immutable publication generations while allowing a failed target to be replaced", () => {
    expectSql(
      "CONSTRAINT listing_publications_scope_generation_uq UNIQUE (scope_id, generation)",
    );
    expectSql(`
      CREATE UNIQUE INDEX listing_publications_active_scope_uidx
      ON marketplace.listing_publications(scope_id)
      WHERE status = 'active'
    `);
    expectSql(`
      CREATE UNIQUE INDEX listing_publications_provider_key_uidx
      ON marketplace.listing_publications(scope_id, provider_publication_key)
      WHERE provider_publication_key IS NOT NULL
    `);
    expect(compactMigration).not.toContain(
      "listing_publications_supersedes_uidx",
    );
    expectSql("prior_generation IS NULL OR prior_generation >= NEW.generation");
    expectSql(
      "A publication may only supersede an earlier generation in its scope",
    );
    expectSql("Publication lineage, desired state, and creator are immutable");
    expectSql(`
      status = 'planned'
      AND provider_publication_key IS NULL
      AND external_listing_id IS NULL
      AND external_url IS NULL
      AND published_at IS NULL
      AND verified_at IS NULL
      AND retired_at IS NULL
    `);
    expectSql(
      "status = 'failed' AND verified_at IS NULL AND retired_at IS NULL",
    );
    expectSql("Publication provider identity and timestamps are append-only");
    expectSql("Publication member provider identities are append-only");
    expectSql(
      "A planned publication cannot gain provider identity while failing",
    );
    expectSql("Terminal listing publications are immutable");
    expectSql(
      "OLD.status = 'active' AND NEW.status NOT IN ('active', 'superseded', 'withdrawn')",
    );
  });

  it("enforces variant/product ownership and immutable publication membership", () => {
    expectSql(`
      CONSTRAINT listing_publication_members_publication_fk
      FOREIGN KEY (publication_id, scope_id, product_id)
      REFERENCES marketplace.listing_publications(id, scope_id, product_id)
      ON DELETE RESTRICT
    `);
    expectSql(`
      CONSTRAINT listing_publication_members_variant_product_fk
      FOREIGN KEY (product_variant_id, product_id)
      REFERENCES catalog.product_variants(id, product_id)
      ON DELETE RESTRICT
    `);
    expectSql(
      "Listing publication member identity and disposition are immutable",
    );
    expectSql(
      "External member identities cannot change after publication activation",
    );
    expectSql(
      "Replacement target membership is sealed after operation creation",
    );
    expectSql("WHERE id = NEW.publication_id FOR UPDATE");
    expectSql("WHERE id = OLD.publication_id FOR UPDATE");
    expectSql("reason_code IS NOT NULL");
  });

  it("makes replacement work scoped, idempotent, leased, and single-flight", () => {
    expectSql(
      "CONSTRAINT listing_replacement_operations_scope_idem_uq UNIQUE (scope_id, idempotency_key)",
    );
    expectSql(
      "CONSTRAINT listing_replacement_operations_target_uq UNIQUE (target_publication_id)",
    );
    expectSql(`
      CREATE UNIQUE INDEX listing_replacement_operations_active_scope_uidx
      ON marketplace.listing_replacement_operations(scope_id)
      WHERE status IN ('planned', 'running', 'compensating', 'manual_recovery_required')
    `);
    expectSql(`
      CREATE INDEX listing_replacement_operations_lease_idx
      ON marketplace.listing_replacement_operations(lease_expires_at, id)
      WHERE status IN ('running', 'compensating')
    `);
    expectSql(`
      CREATE UNIQUE INDEX listing_replacement_steps_running_operation_uidx
      ON marketplace.listing_replacement_steps(operation_id)
      WHERE status = 'running'
    `);
    expectSql("request_hash ~ '^[0-9a-f]{64}$'");
    expectSql(
      "Replacement operation source/target publication contract is invalid",
    );
    expectSql(
      "Replacement operation state_version must advance by exactly one",
    );
    expectSql("Replacement step state_version must advance by exactly one");
    expectSql(
      "NEW.attempt_count NOT IN (OLD.attempt_count, OLD.attempt_count + 1)",
    );
    expectSql("A new operation lease must advance attempt_count by one");
    expectSql("An unexpired operation lease cannot be replaced");
    expectSql("NEW.current_phase IS DISTINCT FROM OLD.current_phase");
    expectSql(
      "attempt_count may only advance when a new operation lease is acquired",
    );
    expectSql("NEW.status = 'running' AND OLD.status IN ('pending', 'failed')");
    expectSql(
      "Starting or retrying a replacement step must advance attempt_count by one",
    );
    expectSql(
      "Replacement step attempt_count may only advance when an attempt starts",
    );
    expectSql(`
      CONSTRAINT listing_replacement_steps_path_phase_chk CHECK (
        (
          execution_path = 'forward'
          AND phase IN ('preflight', 'cutover', 'publish', 'verify', 'switch_mapping')
        ) OR (execution_path = 'compensation' AND phase = 'compensate')
      )
    `);
    expectSql(
      "Replacement step does not match the active operation status and phase",
    );
    expectSql(
      "Forward phase % requires all mandatory steps to succeed before advancement",
    );
    expectSql(
      "Replacement completion requires every mandatory forward step to succeed",
    );
    expectSql(
      "Safe replacement failure requires every compensation step to succeed",
    );
    expectSql(
      "Completed replacement requires a superseded source and active target",
    );
    expectSql(
      "Cancelled replacement requires an active source and untouched failed target",
    );
    expectSql(
      "Failed replacement does not have a verified safe publication outcome",
    );
    expectSql(
      "status = 'failed' AND current_phase IN ('preflight', 'compensate')",
    );
    expectSql(
      "status = 'manual_recovery_required' AND current_phase <> 'complete'",
    );
    expectSql(`
      member.external_variant_id IS NOT NULL
      OR member.external_offer_id IS NOT NULL
      OR member.external_inventory_item_id IS NOT NULL
    `);
  });

  it("constrains operation and step terminal evidence instead of permitting partial success", () => {
    expectSql(`
      status = 'completed'
      AND current_phase = 'complete'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NULL
    `);
    expectSql(`
      status = 'failed'
      AND current_phase IN ('preflight', 'compensate')
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
      AND started_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    `);
    expectSql(`
      status = 'manual_recovery_required'
      AND current_phase <> 'complete'
      AND lease_token IS NULL
    `);
    expectSql(`
      status = 'succeeded' AND attempt_count > 0
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND result_evidence IS NOT NULL AND error_code IS NULL
    `);
    expectSql(`
      status = 'failed' AND attempt_count > 0
      AND started_at IS NOT NULL AND completed_at IS NOT NULL
      AND error_code IS NOT NULL
    `);
  });

  it("keeps replacement evidence append-only and rejects deletion of lifecycle roots", () => {
    expectSql(`
      CREATE TRIGGER listing_replacement_events_immutable
      BEFORE UPDATE OR DELETE ON marketplace.listing_replacement_events
    `);
    expectSql(`
      CREATE TRIGGER listing_replacement_operations_no_delete
      BEFORE DELETE ON marketplace.listing_replacement_operations
    `);
    expectSql(`
      CREATE TRIGGER listing_replacement_steps_no_delete
      BEFORE DELETE ON marketplace.listing_replacement_steps
    `);
    expectSql(`
      CREATE TRIGGER listing_publications_no_delete
      BEFORE DELETE ON marketplace.listing_publications
    `);
    expectSql(`
      CREATE TRIGGER listing_scopes_immutable
      BEFORE UPDATE OR DELETE ON marketplace.listing_scopes
    `);
    expectSql(`
      CREATE TRIGGER channel_listing_scopes_immutable
      BEFORE UPDATE OR DELETE ON marketplace.channel_listing_scopes
    `);
    expectSql(`
      CREATE TRIGGER dropship_listing_scopes_immutable
      BEFORE UPDATE OR DELETE ON marketplace.dropship_listing_scopes
    `);
    expectSql(
      "Marketplace listing replacement history is append-only; % is not allowed",
    );
  });

  it("requires planned creation and at least one included member before activation", () => {
    expectSql("IF NEW.status <> 'planned' THEN");
    expectSql(
      "A listing publication requires at least one included member before activation",
    );
  });

  it("defers operation/publication consistency until the transaction outcome is known", () => {
    expectSql(`
      CREATE CONSTRAINT TRIGGER listing_replacement_operation_publications_consistent
      AFTER INSERT OR UPDATE ON marketplace.listing_replacement_operations
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql(`
      CREATE CONSTRAINT TRIGGER listing_publication_replacement_consistent
      AFTER UPDATE ON marketplace.listing_publications
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql("Planned replacement publication state is inconsistent");
    expectSql("Pre-publication replacement state is inconsistent");
    expectSql("Publishing replacement state is inconsistent");
    expectSql("Verified replacement state is inconsistent");
    expectSql("Compensating replacement publication state is inconsistent");
    expectSql("Manual-recovery publication state is inconsistent");
    expectSql("Completed replacement publication state is inconsistent");
    expectSql(
      "Preflight terminal replacement publication state is inconsistent",
    );
    expectSql("Compensated replacement publication state is inconsistent");
    expectSql(
      "Publication supersession requires a completed replacement operation",
    );
    expectSql("An active replacement source cannot be withdrawn");
  });

  it("serializes audit events and requires exactly one truthful event per subject version", () => {
    expectSql(`
      FROM marketplace.listing_replacement_operations
      WHERE id = NEW.operation_id
      FOR UPDATE
    `);
    expectSql(`
      CREATE UNIQUE INDEX listing_replacement_events_operation_version_uidx
      ON marketplace.listing_replacement_events(operation_id, subject_state_version)
      WHERE step_id IS NULL
    `);
    expectSql(`
      CREATE UNIQUE INDEX listing_replacement_events_step_version_uidx
      ON marketplace.listing_replacement_events(operation_id, step_id, subject_state_version)
      WHERE step_id IS NOT NULL
    `);
    expectSql("step_id IS NOT DISTINCT FROM NEW.step_id");
    expectSql(
      "Replacement event from_status must continue the versioned subject history",
    );
    expectSql("Replacement event sequence must be contiguous per operation");
    expectSql(`
      CREATE CONSTRAINT TRIGGER listing_replacement_operation_event_required
      AFTER INSERT OR UPDATE ON marketplace.listing_replacement_operations
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql(`
      CREATE CONSTRAINT TRIGGER listing_replacement_step_event_required
      AFTER INSERT OR UPDATE ON marketplace.listing_replacement_steps
      DEFERRABLE INITIALLY DEFERRED
    `);
    expectSql("Replacement operation state version % requires an audit event");
    expectSql(
      "Replacement operation audit event does not match state version %",
    );
    expectSql("Replacement step state version % requires an audit event");
    expectSql("Replacement step audit event does not match state version %");
    expectSql("Replacement event type does not match its subject transition");
    expectSql(
      "Replacement operation failure event must preserve error and recovery evidence",
    );
    expectSql("Replacement step failure event must preserve error evidence");
    expectSql("Replacement step success event must preserve result evidence");
  });

  it("keeps each invariant inside its owning trigger function", () => {
    const operationGuard = compactSql(
      functionBody("guard_listing_replacement_operation"),
    );
    const stepGuard = compactSql(
      functionBody("guard_listing_replacement_step"),
    );
    const eventGuard = compactSql(
      functionBody("guard_listing_replacement_event"),
    );
    const publicationConsistency = compactSql(
      functionBody("enforce_listing_replacement_publication_consistency"),
    );

    expect(operationGuard).toContain(
      "Forward phase % requires all mandatory steps to succeed before advancement",
    );
    expect(operationGuard).toContain(
      "Completed replacement requires a superseded source and active target",
    );
    expect(operationGuard).toContain(
      "Safe replacement failure requires every compensation step to succeed",
    );
    expect(stepGuard).toContain(
      "Replacement step does not match the active operation status and phase",
    );
    expect(stepGuard).toContain("FOR UPDATE");
    expect(eventGuard).toContain(
      "Replacement event from_status must continue the versioned subject history",
    );
    expect(publicationConsistency).toContain(
      "Completed replacement publication state is inconsistent",
    );
    expect(publicationConsistency).toContain("target_has_external_effect");
    expect(eventGuard).not.toContain("NEW.current_phase");
    expect(eventGuard).not.toContain("source_status");
  });
});
