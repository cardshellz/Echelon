import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildReplayPlan,
  parseFlags,
  runReplay,
  type Flags,
} from "../replay-rejected-carrier-tracking-receipts";

const verifiedAt = new Date("2026-07-25T16:22:08.000Z");

function payload(overrides: Record<string, unknown> = {}) {
  return {
    resource_type: "API_TRACK",
    resource_url: "https://api.shipstation.com/v2/tracking?carrier_code=ups&tracking_number=1Z16D13WYW23971807",
    data: {
      tracking_number: "1Z16D13WYW23971807",
      status_code: "DE",
      status_description: "Delivered",
      actual_delivery_date: verifiedAt.toISOString(),
      events: [{
        occurred_at: verifiedAt.toISOString(),
        status_code: "DE",
        event_description: "Delivered",
        city_locality: "",
        state_province: "",
        postal_code: "",
        country_code: "",
      }],
      ...overrides,
    },
  };
}

function receiptRow(id: number, rawPayload: unknown, hashOverride?: string) {
  const rawBody = Buffer.from(JSON.stringify(rawPayload), "utf8");
  return {
    id,
    provider: "shipstation",
    receipt_hash: String(id).padStart(64, "a").slice(0, 64),
    signature_algorithm: "RSA-SHA256",
    signature_key_id: "shipstation-v2-key",
    signature_timestamp_raw: verifiedAt.toISOString(),
    signature_timestamp_at: verifiedAt,
    raw_body_base64: rawBody.toString("base64"),
    raw_body_hash: hashOverride ?? createHash("sha256").update(rawBody).digest("hex"),
    signature_base64: "retained-signature",
    signature_hash: "c".repeat(64),
    verified_at: verifiedAt,
  };
}

function flags(overrides: Partial<Flags> = {}): Flags {
  return {
    help: false,
    mode: "dry-run",
    limit: 100,
    confirmCount: null,
    operator: null,
    reason: null,
    idempotencyKey: null,
    json: false,
    ...overrides,
  };
}

describe("replay rejected carrier tracking receipts", () => {
  it("parses guarded dry-run and execute flags", () => {
    expect(parseFlags(["--dry-run", "--limit=all", "--json"])).toMatchObject({
      mode: "dry-run",
      limit: null,
      json: true,
    });
    expect(parseFlags([
      "--execute",
      "--limit=25",
      "--confirm-count=25",
      "--operator=owner@cardshellz.com",
      "--reason=parser-v2-repair",
      "--idempotency-key=batch-1",
    ])).toMatchObject({
      mode: "execute",
      limit: 25,
      confirmCount: 25,
    });
    expect(() => parseFlags(["--execute", "--limit=25"]))
      .toThrow("--confirm-count is required in execute mode");
  });

  it("selects retained delivered payloads with blank optional metadata", async () => {
    const queryable = {
      query: vi.fn().mockResolvedValue({
        rows: [
          receiptRow(1, payload()),
          receiptRow(2, payload({ tracking_number: "" })),
          receiptRow(3, payload(), "f".repeat(64)),
        ],
      }),
    };

    const plan = await buildReplayPlan(queryable, { limit: 100 });

    expect(plan.preview).toMatchObject({
      scannedRows: 3,
      selectedCount: 1,
      stillInvalid: 1,
      integrityFailures: 1,
      selectedSample: [{
        receiptId: 1,
        trackingSuffix: "971807",
        providerStatusCode: "DE",
        dispatchEvidence: "confirmed",
      }],
    });
    expect(queryable.query).toHaveBeenCalledWith(
      expect.stringContaining("legacy_parse.parser_version = $2::text"),
      [0, "shipstation-api-track-v1", "shipstation-api-track-v2", 500],
    );
  });

  it("requires exact confirmation and replays through the carrier service", async () => {
    const queryable = {
      query: vi.fn().mockResolvedValue({ rows: [receiptRow(10, payload())] }),
    };
    const replayVerifiedShipStationWebhook = vi.fn().mockResolvedValue({
      ingestStatus: "normalized",
      eventId: 101,
      eventInserted: true,
      webhookReceiptId: 10,
      webhookReceiptInserted: false,
      parseAttemptId: 201,
      parseAttemptInserted: true,
      matchAttemptId: null,
      matchAttemptInserted: false,
      matchStatus: "pending",
      matchReasonCode: null,
      candidateCount: 0,
      shippingProviderLabelId: null,
      dispatchEvidence: "confirmed",
      dispatchCommandId: null,
      dispatchCommandInserted: false,
    });

    await expect(runReplay(flags({
      mode: "execute",
      confirmCount: 0,
      operator: "owner@cardshellz.com",
      reason: "parser-v2-repair",
      idempotencyKey: "batch-1",
    }), {
      queryable,
      service: { replayVerifiedShipStationWebhook },
    })).rejects.toThrow("does not match selected dry-run count 1");

    const result = await runReplay(flags({
      mode: "execute",
      confirmCount: 1,
      operator: "owner@cardshellz.com",
      reason: "parser-v2-repair",
      idempotencyKey: "batch-1",
    }), {
      queryable,
      service: { replayVerifiedShipStationWebhook },
    });

    expect(result).toMatchObject({
      normalized: 1,
      eventsInserted: 1,
      parseAttemptsInserted: 1,
      failed: 0,
    });
    expect(replayVerifiedShipStationWebhook).toHaveBeenCalledWith(
      payload(),
      expect.objectContaining({ rawBodyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      {
        operator: "owner@cardshellz.com",
        reason: "parser-v2-repair",
        idempotencyKey: "batch-1",
      },
    );
  });
});