export type FlowReplayActionKind = "webhook_inbox" | "webhook_retry" | "oms_remediation";

export interface FlowReplayAction {
  kind: FlowReplayActionKind;
  sourceId: number;
  endpoint: string;
  body?: Record<string, unknown>;
  label: string;
  pendingLabel: string;
  successTitle: string;
}

export interface ReplayableFlowIssue {
  code: string;
  replaySafe: boolean;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value.trim())) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveFlowReplayAction(
  issue: ReplayableFlowIssue,
  evidence: Record<string, unknown>,
): FlowReplayAction | null {
  if (!issue.replaySafe) return null;

  if (issue.code === "OMS_PAID_WITHOUT_WMS") {
    const replayOutcome = typeof evidence._replay_outcome === "string"
      ? evidence._replay_outcome
      : null;
    if (replayOutcome === "failed") {
      const retryQueueId = positiveInteger(evidence._replay_retry_id);
      return retryQueueId === null
        ? null
        : {
            kind: "webhook_retry",
            sourceId: retryQueueId,
            endpoint: `/api/oms/ops/webhook-retry/${retryQueueId}/requeue`,
            label: "Retry failed replay",
            pendingLabel: "Requeuing replay",
            successTitle: "Paid event replay requeued",
          };
    }
    if (replayOutcome !== null) return null;

    const omsOrderId = positiveInteger(evidence.oms_order_id);
    const sourceInboxId = positiveInteger(evidence._replay_source_inbox_id);
    return omsOrderId === null || sourceInboxId === null
      ? null
      : {
          kind: "oms_remediation",
          sourceId: omsOrderId,
          endpoint: "/api/oms/ops/reconciliation/remediate",
          body: { code: issue.code, omsOrderId },
          label: "Replay paid event",
          pendingLabel: "Queuing paid replay",
          successTitle: "Paid event replay queued",
        };
  }

  if (issue.code === "WEBHOOK_INBOX_FAILED") {
    const inboxId = positiveInteger(evidence.inbox_id);
    return inboxId === null
      ? null
      : {
          kind: "webhook_inbox",
          sourceId: inboxId,
          endpoint: `/api/oms/ops/webhook-inbox/${inboxId}/replay`,
          label: "Replay webhook",
          pendingLabel: "Queuing replay",
          successTitle: "Webhook replay queued",
        };
  }

  const retryQueueId = positiveInteger(evidence.retry_id);
  return retryQueueId === null
    ? null
    : {
        kind: "webhook_retry",
        sourceId: retryQueueId,
        endpoint: `/api/oms/ops/webhook-retry/${retryQueueId}/requeue`,
        label: "Requeue retry",
        pendingLabel: "Requeuing retry",
        successTitle: "Retry requeued",
      };
}
