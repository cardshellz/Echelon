import { classify, type ErrorClass, AppError } from "./errors";
import { getContext } from "./log-context";
import { logger, redactLogData } from "./logger";

export const ALERT_WEBHOOK_TIMEOUT_MS = 10_000;

interface ReportOptions {
  action?: string;
  context?: Record<string, unknown>;
}

export async function reportError(err: unknown, opts?: ReportOptions): Promise<void> {
  const errClass = classify(err);
  const action = opts?.action ?? "unhandled_error";
  const ctx = getContext();
  const safeContext = redactLogData({
    ...(opts?.context ?? {}),
    ...(ctx ?? {}),
  });

  const errorCode = err instanceof AppError
    ? err.code
    : (err as any)?.code ?? "UNKNOWN";

  const message = err instanceof Error ? err.message : String(err);

  logger.error(action, {
    outcome: "error",
    error_code: errorCode,
    error_class: errClass,
    error_message: message,
    ...safeContext,
  });

  if (errClass === "permanent" || errClass === "fatal") {
    await sendAlert(errClass, errorCode, message, safeContext);
  }
}

async function sendAlert(
  errClass: ErrorClass,
  code: string,
  message: string,
  context: Record<string, unknown>,
): Promise<void> {
  const webhookUrl =
    process.env.OMS_OPS_ALERT_WEBHOOK_URL ??
    process.env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) return;

  const severity = errClass === "fatal" ? "FATAL" : "PERMANENT";
  const safeContext = redactLogData(context);
  const body = {
    content: [
      `**[${severity}]** \`${code}\``,
      message,
      Object.keys(safeContext).length > 0
        ? "```json\n" + JSON.stringify(safeContext, null, 2) + "\n```"
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ALERT_WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("alert.webhook_non_2xx", {
        outcome: "degraded",
        status: response.status,
        error_code: code,
        error_class: errClass,
      });
    }
  } catch (alertErr) {
    // Alert delivery is best-effort, but record bounded failure telemetry.
    logger.warn("alert.webhook_failed", {
      outcome: "degraded",
      error_code: code,
      error_class: errClass,
      alert_error: alertErr instanceof Error ? alertErr.message : String(alertErr),
    });
  }
}
