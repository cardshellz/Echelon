import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { normalizeShipStationTrackingWebhook } from "../../carrier-tracking.domain";
import {
  createDrizzleCarrierTrackingRepository,
  type CarrierTrackingRepository,
  type ClaimedCarrierTrackingLabelPoll,
  type FinalizeCarrierTrackingLabelPollAttemptInput,
} from "../../carrier-tracking.repository";
import { CarrierTrackingService } from "../../carrier-tracking.service";
import { ShipStationTrackingEventsError } from "../../shipstation-tracking-events.client";

const databaseSuite = process.env.ECHELON_TEST_DATABASE_URL
  && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const now = new Date("2026-09-20T12:00:00Z");
const earlier = new Date("2026-09-20T11:00:00Z");
const later = (milliseconds: number): Date => new Date(now.getTime() + milliseconds);

// Only foreign-owner relations are reduced fixtures. All shipping tracking
// tables, constraints and immutable-ledger triggers come from real migrations.
const ownerFixture = `
  CREATE SCHEMA wms;
  CREATE TABLE wms.orders (id INTEGER PRIMARY KEY, order_number TEXT NOT NULL);
  CREATE TABLE wms.outbound_shipments (
    id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES wms.orders(id), status TEXT NOT NULL
  );
  CREATE TABLE wms.shipment_requests (id BIGINT PRIMARY KEY, wms_order_id INTEGER);
  CREATE TABLE wms.shipping_engine_orders (id BIGINT PRIMARY KEY, shipment_request_id BIGINT);
  CREATE TABLE wms.physical_shipments (
    id BIGINT PRIMARY KEY, shipment_request_id BIGINT,
    provider TEXT, provider_physical_shipment_id TEXT
  );
  CREATE TABLE wms.reconciliation_exceptions (id BIGINT PRIMARY KEY, classification TEXT NOT NULL);
`;

function snapshot(trackingNumber: string, statusCode = "IT", carrierCode = "ups") {
  return {
    tracking_number: trackingNumber,
    carrier_code: carrierCode,
    status_code: statusCode,
    events: [{ occurred_at: earlier.toISOString(), description: "Processing at carrier facility" }],
  };
}

databaseSuite.sequential("carrier tracking recovery PostgreSQL guarantees", () => {
  const databaseName = `carrier_tracking_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Client | undefined;
  let pool: pg.Pool;
  let created = false;
  let repository: CarrierTrackingRepository;

  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    if (!/^carrier_tracking_[a-f0-9]{32}$/.test(databaseName)) throw new Error("Unsafe test database name");
    admin = new pg.Client({ connectionString: process.env.ECHELON_TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const url = new URL(process.env.ECHELON_TEST_DATABASE_URL!);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    await pool.query(ownerFixture);
    for (const name of [
      "154_carrier_tracking_event_authority.sql",
      "165_carrier_dispatch_authority_cutover.sql",
      "0603_shipping_provider_label_direction.sql",
      "184_shipping_provider_label_unknown_direction.sql",
      "0604_carrier_tracking_label_poll_fallback.sql",
      "0686_carrier_tracking_matched_lineage_retry.sql",
      // Migration replay must preserve the new retry contract.
      "0686_carrier_tracking_matched_lineage_retry.sql",
    ]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", name), "utf8"));
    }
    repository = createDrizzleCarrierTrackingRepository(drizzle(pool));
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE wms.carrier_tracking_events, wms.shipping_provider_labels,
      wms.orders RESTART IDENTITY CASCADE;
      INSERT INTO wms.orders VALUES (1, '#TRACKING-RECOVERY');
      INSERT INTO wms.outbound_shipments VALUES (1, 1, 'queued');`);
  });

  afterAll(async () => {
    try {
      await pool?.end();
      if (created) await admin!.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin?.end();
    }
  });

  async function seedLabel(tracking: string, options: {
    linked?: boolean; carrier?: string; direction?: "outbound" | "return"; voided?: boolean;
  } = {}) {
    const result = await pool.query<{ id: string }>(`
      INSERT INTO wms.shipping_provider_labels (
        provider, provider_label_id, tracking_number, normalized_tracking_number,
        label_status, label_direction, carrier, voided_at,
        first_observed_at, last_observed_at, source, created_at, updated_at
      ) VALUES ('shipstation', $1, $1, $1, $2, $3, $4, $5, $6, $6, 'integration', $6, $6)
      RETURNING id::text`, [tracking, options.voided ? "voided" : "active",
      options.direction ?? "outbound", options.carrier ?? "ups", options.voided ? earlier : null, earlier]);
    const id = Number(result.rows[0].id);
    if (options.linked !== false) await addLink(id);
    return id;
  }

  async function addLink(labelId: number) {
    await pool.query(`INSERT INTO wms.shipping_provider_label_links
      (shipping_provider_label_id, legacy_wms_shipment_id, source)
      VALUES ($1, 1, 'integration')`, [labelId]);
  }

  function service(asOf = now) {
    const getLabelTrackingSnapshot = vi.fn(async (request: { trackingNumber: string }) => ({
      httpStatus: 200 as const, payload: snapshot(request.trackingNumber),
    }));
    const getTrackingSnapshot = vi.fn(async (request: { trackingNumber: string }) => ({
      httpStatus: 200 as const, payload: snapshot(request.trackingNumber),
    }));
    return {
      getLabelTrackingSnapshot,
      service: new CarrierTrackingService({
        repository,
        clock: { now: () => new Date(asOf) },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        labelPollLeaseOwner: "integration-poll-worker",
        trackingEventsClient: { isConfigured: () => true, getLabelTrackingSnapshot, getTrackingSnapshot },
      }),
    };
  }

  function failureInput(poll: ClaimedCarrierTrackingLabelPoll): FinalizeCarrierTrackingLabelPollAttemptInput {
    return {
      shippingProviderLabelId: poll.shippingProviderLabelId,
      attemptNumber: poll.attemptNumber,
      leaseOwner: poll.leaseOwner,
      outcome: "retry_scheduled",
      httpStatus: 503,
      carrierTrackingEventId: null,
      dispatchEvidence: null,
      errorCode: "PROVIDER_UNAVAILABLE",
      errorMessage: "Provider unavailable",
      requestEvidence: { providerLabelId: poll.providerLabelId },
      responseEvidence: { httpStatus: 503 },
      startedAt: poll.startedAt,
      completedAt: new Date(poll.startedAt.getTime() + 1_000),
      nextAttemptAt: new Date(poll.startedAt.getTime() + 300_000),
    };
  }

  it("accepts the UPS account/carrier split and creates one durable command across replay and concurrency", async () => {
    const tracking = "1ZTEST000000000001";
    const labelId = await seedLabel(tracking, { carrier: "ups_walleted" });
    const test = service();

    expect(await test.service.pollShipStationLabels(25)).toMatchObject({
      labelPollsClaimed: 1, labelPollsConfirmed: 1, errors: 0,
    });
    expect((await pool.query(`SELECT poll_status, confirmed_at, lease_owner
      FROM wms.carrier_tracking_label_polls WHERE shipping_provider_label_id=$1`, [labelId])).rows)
      .toEqual([{ poll_status: "complete", confirmed_at: now, lease_owner: null }]);
    expect((await pool.query("SELECT carrier FROM wms.shipping_provider_labels")).rows).toEqual([{ carrier: "ups_walleted" }]);
    expect((await pool.query("SELECT carrier FROM wms.carrier_tracking_events")).rows).toEqual([{ carrier: "ups" }]);

    await Promise.all([1, 2].map(() => test.service.hydrateShipStationTrackingIdentity({
      carrierCode: "ups", trackingNumber: tracking,
    })));
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_dispatch_commands")).rows).toEqual([{ count: 1 }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_tracking_label_poll_attempts")).rows).toEqual([{ count: 1 }]);
    expect(await test.service.pollShipStationLabels(25)).toMatchObject({ labelPollsClaimed: 0, errors: 0 });
    expect(test.getLabelTrackingSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "retry_scheduled", "review_required"] as const)("commits %s polling evidence and its correctly typed projection", async (outcome) => {
    await seedLabel("1ZTEST000000000002");
    const test = service();
    if (outcome === "waiting") {
      test.getLabelTrackingSnapshot.mockResolvedValueOnce({
        httpStatus: 200,
        payload: { ...snapshot("1ZTEST000000000002", "NY"), events: [] },
      });
    } else {
      test.getLabelTrackingSnapshot.mockRejectedValueOnce(new ShipStationTrackingEventsError(
        "HTTP", "Provider request failed", { status: outcome === "retry_scheduled" ? 503 : 401 },
      ));
    }

    expect(await test.service.pollShipStationLabels(25)).toMatchObject({ errors: 0 });
    const projection = (await pool.query(`SELECT poll_status, confirmed_at, next_attempt_at, lease_owner,
      consecutive_failure_count FROM wms.carrier_tracking_label_polls`)).rows[0];
    expect(projection).toEqual({
      poll_status: outcome === "waiting" ? "waiting" : outcome === "retry_scheduled" ? "retry" : "review",
      confirmed_at: null,
      next_attempt_at: outcome === "review_required" ? null : later(outcome === "waiting" ? 900_000 : 300_000),
      lease_owner: null,
      consecutive_failure_count: outcome === "waiting" ? 0 : 1,
    });
    expect((await pool.query("SELECT attempt_outcome FROM wms.carrier_tracking_label_poll_attempts")).rows)
      .toEqual([{ attempt_outcome: outcome }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_dispatch_commands")).rows).toEqual([{ count: 0 }]);
  });

  it("reclaims an expired lease, rejects the stale worker and idempotently finalizes the current attempt", async () => {
    await seedLabel("1ZTEST000000000003");
    await repository.prepareLabelTrackingPolls(25, now);
    const claims = await Promise.all([
      repository.claimLabelTrackingPolls(25, now, "worker-a", later(60_000)),
      repository.claimLabelTrackingPolls(25, now, "worker-b", later(60_000)),
    ]);
    expect(claims.flat()).toHaveLength(1);
    const old = claims.flat()[0];
    const [current] = await repository.claimLabelTrackingPolls(25, later(60_001), "worker-c", later(120_001));
    expect(current.attemptNumber).toBe(old.attemptNumber);
    await expect(repository.finalizeLabelTrackingPollAttempt(failureInput(old))).rejects.toThrow("lease was lost");
    const first = await repository.finalizeLabelTrackingPollAttempt(failureInput(current));
    expect(first).toMatchObject({ inserted: true, outcome: "retry_scheduled" });
    expect(await repository.finalizeLabelTrackingPollAttempt(failureInput(current)))
      .toEqual({ ...first, inserted: false });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_tracking_label_poll_attempts")).rows).toEqual([{ count: 1 }]);
  });

  it("rolls back attempt evidence with a failed projection update and permits a safe retry", async () => {
    await seedLabel("1ZTEST000000000004");
    await repository.prepareLabelTrackingPolls(25, now);
    const [poll] = await repository.claimLabelTrackingPolls(25, now, "worker", later(60_000));
    await pool.query(`CREATE FUNCTION wms.fail_test_poll_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture projection failure'; END $$;
      CREATE TRIGGER fail_test_poll_update BEFORE UPDATE ON wms.carrier_tracking_label_polls
      FOR EACH ROW EXECUTE FUNCTION wms.fail_test_poll_update();`);
    try {
      await expect(repository.finalizeLabelTrackingPollAttempt(failureInput(poll))).rejects.toThrow("fixture projection failure");
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_tracking_label_poll_attempts")).rows).toEqual([{ count: 0 }]);
      expect((await pool.query("SELECT poll_status FROM wms.carrier_tracking_label_polls")).rows).toEqual([{ poll_status: "processing" }]);
    } finally {
      await pool.query(`DROP TRIGGER fail_test_poll_update ON wms.carrier_tracking_label_polls;
        DROP FUNCTION wms.fail_test_poll_update();`);
    }
    await expect(repository.finalizeLabelTrackingPollAttempt(failureInput(poll))).resolves.toMatchObject({ inserted: true });
  });

  it("moves unlinked label matches out of the first batch and resumes them when a shipment link arrives", async () => {
    const tracks = ["1ZTEST000000000010", "1ZTEST000000000011", "1ZTEST000000000012"];
    const labels: number[] = [];
    for (const [index, tracking] of tracks.entries()) {
      labels.push(await seedLabel(tracking, { linked: index === 2 }));
      const event = normalizeShipStationTrackingWebhook({
        resource_type: "API_TRACK",
        resource_url: `https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=${tracking}`,
        data: snapshot(tracking),
      }, new Date(earlier.getTime() + index));
      await repository.transaction(tx => tx.insertOrGetEvent(event));
    }
    expect((await repository.listEventsPendingReconciliation(2, now)).map(event => event.trackingNumber)).toEqual(tracks.slice(0, 2));
    const test = service();
    for (const tracking of tracks.slice(0, 2)) {
      expect(await test.service.hydrateShipStationTrackingIdentity({ carrierCode: "ups", trackingNumber: tracking }))
        .toMatchObject({ matchStatus: "matched", dispatchCommandId: null });
    }
    // Replay must also retain already scheduled matches, not just work on an
    // empty table during setup.
    await pool.query(readFileSync(resolve(process.cwd(), "migrations",
      "0686_carrier_tracking_matched_lineage_retry.sql"), "utf8"));
    expect((await pool.query(`SELECT last_match_status, next_reconcile_at
      FROM wms.carrier_tracking_reconciliation_state ORDER BY carrier_tracking_event_id`)).rows)
      .toEqual([1, 2].map(() => ({ last_match_status: "matched", next_reconcile_at: later(1_800_000) })));
    expect((await repository.listEventsPendingReconciliation(2, now)).map(event => event.trackingNumber)).toEqual([tracks[2]]);
    await test.service.hydrateShipStationTrackingIdentity({ carrierCode: "ups", trackingNumber: tracks[2] });

    await addLink(labels[0]);
    await pool.query("UPDATE wms.shipping_provider_labels SET updated_at=$1 WHERE id=$2", [later(500), labels[0]]);
    expect((await repository.listEventsPendingReconciliation(2, later(1_000))).map(event => event.trackingNumber)).toEqual([tracks[0]]);
    expect(await service(later(1_000)).service.hydrateShipStationTrackingIdentity({ carrierCode: "ups", trackingNumber: tracks[0] }))
      .toMatchObject({ matchStatus: "matched", dispatchCommandInserted: true });
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_dispatch_commands")).rows).toEqual([{ count: 2 }]);
    expect(await repository.listEventsPendingReconciliation(2, later(1_000))).toEqual([]);
    expect((await repository.listEventsPendingReconciliation(2, later(1_800_000))).map(event => event.trackingNumber)).toEqual([tracks[1]]);
  });

  it("reconciles a persisted event without loading or rewriting its audit payload", async () => {
    const trackingNumber = "1ZTEST000000000019";
    const labelId = await seedLabel(trackingNumber);
    // The label link is already established; this case exercises event replay,
    // not the independent provider-label link recovery query.
    await pool.query(
      "UPDATE wms.shipping_provider_labels SET last_link_reconciled_at = $1 WHERE id = $2",
      [now, labelId],
    );
    const event = normalizeShipStationTrackingWebhook({
      resource_type: "API_TRACK",
      resource_url: `https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=${trackingNumber}`,
      data: snapshot(trackingNumber),
    }, earlier);
    const stored = await repository.transaction(tx => tx.insertOrGetEvent(event));

    const pending = await repository.listEventsPendingReconciliation(25, now);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: stored.id, eventHash: event.eventHash });
    expect(pending[0]).not.toHaveProperty("sanitizedPayload");

    const errorLogs = vi.fn();
    const sweep = new CarrierTrackingService({
      repository,
      clock: { now: () => new Date(now) },
      logger: { info: vi.fn(), warn: vi.fn(), error: errorLogs },
    });
    const result = await sweep.reconcileUnresolved(25);
    expect(errorLogs).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 1,
      matched: 1,
      errors: 0,
    });
    const events = await pool.query<{ id: string; sanitized_payload: Record<string, unknown> }>(
      "SELECT id::text, sanitized_payload FROM wms.carrier_tracking_events",
    );
    expect(events.rows).toEqual([{
      id: String(stored.id),
      sanitized_payload: event.sanitizedPayload,
    }]);
    const attempts = await pool.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM wms.carrier_tracking_event_matches WHERE carrier_tracking_event_id = $1",
      [stored.id],
    );
    expect(attempts.rows).toEqual([{ count: 1 }]);
  });

  it.each([{ direction: "return" as const }, { voided: true }])("does not poll or dispatch ineligible labels: %j", async (options) => {
    await seedLabel("1ZTEST000000000020", options);
    const test = service();
    expect(await test.service.pollShipStationLabels(25)).toMatchObject({ labelPollsClaimed: 0, errors: 0 });
    expect(test.getLabelTrackingSnapshot).not.toHaveBeenCalled();
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.carrier_dispatch_commands")).rows).toEqual([{ count: 0 }]);
  });

  it("retains the retry-shape guard against incomplete and contradictory states", async () => {
    const tracking = "1ZTEST000000000030";
    await seedLabel(tracking);
    await service().service.hydrateShipStationTrackingIdentity({ carrierCode: "ups", trackingNumber: tracking });
    for (const [status, retryAt] of [
      ["matched", now],
      ["voided_label", later(60_000)],
      ["unmatched", null],
      ["ambiguous", null],
      ["review", null],
    ] as const) {
      await expect(pool.query(`UPDATE wms.carrier_tracking_reconciliation_state
        SET last_match_status=$1, next_reconcile_at=$2`, [status, retryAt]))
        .rejects.toMatchObject({ code: "23514", constraint: "carrier_tracking_reconciliation_state_retry_shape_chk" });
    }
    expect((await pool.query("SELECT last_match_status, next_reconcile_at FROM wms.carrier_tracking_reconciliation_state")).rows)
      .toEqual([{ last_match_status: "matched", next_reconcile_at: null }]);
  });
});
