import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repositorySource = readFileSync(
  join(here, "..", "..", "carrier-tracking.repository.ts"),
  "utf8",
);
const migrationSource = readFileSync(
  join(
    here,
    "..",
    "..",
    "..",
    "..",
    "..",
    "migrations",
    "0604_carrier_tracking_label_poll_fallback.sql",
  ),
  "utf8",
);

describe("exact-label tracking poll repository contract", () => {
  it("polls only unresolved outbound ShipStation labels with canonical links", () => {
    const start = repositorySource.indexOf("async prepareLabelTrackingPolls(");
    const end = repositorySource.indexOf(
      "async claimLabelTrackingPolls(",
      start,
    );
    const method = repositorySource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(method).toContain("label.provider = 'shipstation'");
    expect(method).toContain("label.label_direction = 'outbound'");
    expect(method).toContain("label.label_status IN ('active', 'unknown')");
    expect(method).toContain("FROM wms.shipping_provider_label_links AS link");
    expect(method).toContain("JOIN wms.outbound_shipments AS legacy");
    expect(method).toContain(
      "legacy.status IN ('planned', 'queued', 'labeled', 'on_hold')",
    );
    expect(method).toContain("FROM wms.carrier_dispatch_commands AS command");
    expect(method).toContain("FROM wms.physical_shipments AS physical");
    expect(method).toContain(
      "'shipstation_shipment:' || label.provider_label_id",
    );
    expect(method).toContain("label.label_created_at");
  });

  it("claims due work with an expiring lease and skip-locked rows", () => {
    const start = repositorySource.indexOf("async claimLabelTrackingPolls(");
    const end = repositorySource.indexOf(
      "async finalizeLabelTrackingPollAttempt(",
      start,
    );
    const method = repositorySource.slice(start, end);

    expect(method).toContain("FOR UPDATE OF poll SKIP LOCKED");
    expect(method).toContain("poll.lease_expires_at <= ${asOf}");
    expect(method).toContain("poll_status = 'processing'");
    expect(method).toContain("JOIN wms.outbound_shipments AS legacy");
    expect(method).toContain("FROM wms.carrier_dispatch_commands AS command");
    expect(method).toContain("FROM wms.physical_shipments AS physical");
  });

  it("retires stale work without stealing a live processing lease", () => {
    const start = repositorySource.indexOf("async prepareLabelTrackingPolls(");
    const end = repositorySource.indexOf(
      "async claimLabelTrackingPolls(",
      start,
    );
    const method = repositorySource.slice(start, end);

    expect(method).toContain("poll_status = 'retired'");
    expect(method).toContain("LABEL_POLL_NO_LONGER_ELIGIBLE");
    expect(method).toContain("poll.lease_expires_at <= ${asOf}");
    expect(migrationSource).toContain("'review', 'retired'");
  });

  it("appends immutable attempt evidence before updating the mutable projection", () => {
    const start = repositorySource.indexOf(
      "async finalizeLabelTrackingPollAttempt(input)",
    );
    const end = repositorySource.indexOf(
      "async prepareTrackingSubscriptions(",
      start,
    );
    const method = repositorySource.slice(start, end);

    expect(
      method.indexOf("INSERT INTO wms.carrier_tracking_label_poll_attempts"),
    ).toBeGreaterThan(-1);
    expect(
      method.indexOf("UPDATE wms.carrier_tracking_label_polls"),
    ).toBeGreaterThan(
      method.indexOf("INSERT INTO wms.carrier_tracking_label_poll_attempts"),
    );
    expect(migrationSource).toContain(
      "carrier_tracking_label_poll_attempts_immutable",
    );
    expect(migrationSource).toContain(
      "wms.reject_shipping_evidence_ledger_mutation()",
    );
  });
});
