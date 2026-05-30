import { classify, type ErrorClass, AppError } from "./errors";
import { getContext } from "./log-context";
import { logger } from "./logger";

interface ReportOptions {
  action?: string;
  context?: Record<string, unknown>;
}

export async function reportError(err: unknown, opts?: ReportOptions): Promise<void> {
  const errClass = classify(err);
  const action = opts?.action ?? "unhandled_error";
  const ctx = getContext();

  const errorCode = err instanceof AppError
    ? err.code
    : (err as any)?.code ?? "UNKNOWN";

  const message = err instanceof Error ? err.message : String(err);

  logger.error(action, {
    outcome: "error",
    error_code: errorCode,
    error_class: errClass,
    error_message: message,
    ...opts?.context,
    ...(ctx ?? {}),
  });

  if (errClass === "permanent" || errClass === "fatal") {
    await sendAlert(errClass, errorCode, message, {
      ...opts?.context,
      ...(ctx ?? {}),
    });
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
  const body = {
    content: [
      `**[${severity}]** \`${code}\``,
      message,
      Object.keys(context).length > 0
        ? "```json\n" + JSON.stringify(context, null, 2) + "\n```"
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Alert delivery is best-effort
  }
}
