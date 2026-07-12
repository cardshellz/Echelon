export type FlowReplayActionKind = "webhook_inbox" | "webhook_retry";

export interface FlowReplayAction {
  kind: FlowReplayActionKind;
  sourceId: number;
  endpoint: string;
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
