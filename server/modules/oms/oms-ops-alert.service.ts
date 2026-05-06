import { getOmsOpsHealth, type OmsOpsHealthSummary, type OmsOpsIssue } from "./ops-health.service";

const LOG_PREFIX = "[OMS Ops Alert]";
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

let lastAlertSignature: string | null = null;
let lastAlertAt = 0;

function getDefaultDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../db").db;
}

function getWithAdvisoryLock(): <T>(lockId: number, fn: () => Promise<T>) => Promise<T | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../infrastructure/scheduler-lock").withAdvisoryLock;
}

export interface OmsOpsAlertDecision {
  shouldAlert: boolean;
  signature: string;
  reason: "not_critical" | "cooldown" | "new_critical_signature";
  criticalIssues: OmsOpsIssue[];
}

export interface OmsOpsAlertSendResult {
  sent: boolean;
  reason: string;
  signature: string;
}

export function buildOmsOpsAlertSignature(health: OmsOpsHealthSummary): string {
  return health.issues
    .filter((issue) => issue.severity === "critical" && issue.count > 0)
    .map((issue) => `${issue.code}:${issue.count}`)
    .sort()
    .join("|");
}

export function evaluateOmsOpsAlert(
  health: OmsOpsHealthSummary,
  nowMs = Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
): OmsOpsAlertDecision {
  const criticalIssues = health.issues.filter((issue) => issue.severity === "critical" && issue.count > 0);
  const signature = buildOmsOpsAlertSignature(health);

  if (criticalIssues.length === 0) {
    return { shouldAlert: false, signature, reason: "not_critical", criticalIssues };
  }

  if (signature === lastAlertSignature && nowMs - lastAlertAt < cooldownMs) {
    return { shouldAlert: false, signature, reason: "cooldown", criticalIssues };
  }

  return { shouldAlert: true, signature, reason: "new_critical_signature", criticalIssues };
}

export function buildOmsOpsAlertPayload(health: OmsOpsHealthSummary, criticalIssues: OmsOpsIssue[]) {
  const topLines = criticalIssues
    .slice(0, 8)
    .map((issue) => `- ${issue.code}: ${issue.count} - ${issue.message}`);
  const sample = criticalIssues[0]?.sample?.slice(0, 2) ?? [];

  return {
    content: [
      `CRITICAL: OMS/WMS flow health is ${health.status}`,
      `Critical count: ${health.counts.critical}; warning count: ${health.counts.warning}`,
      ...topLines,
      sample.length ? `Sample: ${JSON.stringify(sample)}` : "",
    ].filter(Boolean).join("\n"),
  };
}

export async function sendOmsOpsAlert(
  health: OmsOpsHealthSummary,
  options: {
    webhookUrl?: string | null;
    fetchImpl?: typeof fetch;
    nowMs?: number;
    cooldownMs?: number;
  } = {},
): Promise<OmsOpsAlertSendResult> {
  const nowMs = options.nowMs ?? Date.now();
  const decision = evaluateOmsOpsAlert(health, nowMs, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);

  if (!decision.shouldAlert) {
    return { sent: false, reason: decision.reason, signature: decision.signature };
  }

  const webhookUrl =
    options.webhookUrl ||
    process.env.OMS_OPS_ALERT_WEBHOOK_URL ||
    process.env.DISCORD_WEBHOOK_URL ||
    null;

  if (!webhookUrl) {
    console.warn(`${LOG_PREFIX} critical health detected but OMS_OPS_ALERT_WEBHOOK_URL is not configured`);
    lastAlertSignature = decision.signature;
    lastAlertAt = nowMs;
    return { sent: false, reason: "webhook_not_configured", signature: decision.signature };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildOmsOpsAlertPayload(health, decision.criticalIssues)),
  });

  if (!response.ok) {
    throw new Error(`OMS ops alert webhook returned ${response.status}`);
  }

  lastAlertSignature = decision.signature;
  lastAlertAt = nowMs;
  return { sent: true, reason: decision.reason, signature: decision.signature };
}

export async function runOmsOpsAlertCheck(dbArg: any = getDefaultDb()): Promise<OmsOpsAlertSendResult> {
  const health = await getOmsOpsHealth(dbArg);
  const result = await sendOmsOpsAlert(health);
  if (result.sent) {
    console.warn(`${LOG_PREFIX} sent critical alert signature=${result.signature}`);
  }
  return result;
}

export function resetOmsOpsAlertStateForTests(): void {
  lastAlertSignature = null;
  lastAlertAt = 0;
}

export function startOmsOpsAlertScheduler(dbArg: any = getDefaultDb()): void {
  if (process.env.DISABLE_SCHEDULERS === "true") return;
  const withAdvisoryLock = getWithAdvisoryLock();
  const lockId = 918406;

  const runLocked = () =>
    withAdvisoryLock(lockId, async () => {
      await runOmsOpsAlertCheck(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} scheduled run error: ${err.message}`));

  console.log(`${LOG_PREFIX} Scheduler started (every 5 minutes, dyno-safe lock)`);
  setTimeout(runLocked, 45_000);
  setInterval(runLocked, 5 * 60 * 1000);
}
