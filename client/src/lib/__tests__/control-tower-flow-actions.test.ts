import { describe, expect, it } from "vitest";

import { resolveFlowReplayAction } from "../control-tower-flow-actions";

describe("resolveFlowReplayAction", () => {
  it("maps a paid-without-WMS row to the guarded OMS remediation endpoint", () => {
    expect(resolveFlowReplayAction(
      { code: "OMS_PAID_WITHOUT_WMS", replaySafe: true },
      { oms_order_id: "255347", _replay_source_inbox_id: 79377 },
    )).toEqual({
      kind: "oms_remediation",
      sourceId: 255347,
      endpoint: "/api/oms/ops/reconciliation/remediate",
      body: { code: "OMS_PAID_WITHOUT_WMS", omsOrderId: 255347 },
      label: "Replay paid event",
      pendingLabel: "Queuing paid replay",
      successTitle: "Paid event replay queued",
    });
  });

  it("does not render paid replay without both the OMS order and canonical paid source", () => {
    const issue = { code: "OMS_PAID_WITHOUT_WMS", replaySafe: true };
    expect(resolveFlowReplayAction(issue, {
      oms_order_id: 255347,
      _replay_source_inbox_id: null,
    })).toBeNull();
    expect(resolveFlowReplayAction(issue, {
      _replay_source_inbox_id: 79377,
    })).toBeNull();
  });

  it("maps a replay-safe failed inbox row to the existing OMS replay endpoint", () => {
    expect(resolveFlowReplayAction(
      { code: "WEBHOOK_INBOX_FAILED", replaySafe: true },
      { inbox_id: "75058" },
    )).toEqual({
      kind: "webhook_inbox",
      sourceId: 75058,
      endpoint: "/api/oms/ops/webhook-inbox/75058/replay",
      label: "Replay webhook",
      pendingLabel: "Queuing replay",
      successTitle: "Webhook replay queued",
    });
  });

  it("maps a replay-safe dead-letter row to the existing retry endpoint", () => {
    expect(resolveFlowReplayAction(
      { code: "SHOPIFY_REFUND_CASCADE_FAILED", replaySafe: true },
      { retry_id: 115802 },
    )).toEqual({
      kind: "webhook_retry",
      sourceId: 115802,
      endpoint: "/api/oms/ops/webhook-retry/115802/requeue",
      label: "Requeue retry",
      pendingLabel: "Requeuing retry",
      successTitle: "Retry requeued",
    });
  });

  it("does not expose mutations for evidence marked unsafe to replay", () => {
    expect(resolveFlowReplayAction(
      { code: "BLOCKED_DUP_INGEST", replaySafe: false },
      { inbox_id: 75058, retry_id: 115802 },
    )).toBeNull();
  });

  it("does not treat an inbox id on another issue type as replay authority", () => {
    expect(resolveFlowReplayAction(
      { code: "UNCLASSIFIED", replaySafe: true },
      { inbox_id: 75058 },
    )).toBeNull();
  });

  it.each([undefined, null, 0, -1, 1.5, "", "0", "1.5", "not-an-id"])(
    "rejects invalid source id %p",
    (sourceId) => {
      expect(resolveFlowReplayAction(
        { code: "WEBHOOK_INBOX_FAILED", replaySafe: true },
        { inbox_id: sourceId },
      )).toBeNull();
      expect(resolveFlowReplayAction(
        { code: "SHOPIFY_REFUND_CASCADE_FAILED", replaySafe: true },
        { retry_id: sourceId },
      )).toBeNull();
    },
  );
});
