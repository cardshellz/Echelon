import { logger } from "./logger";

type BackgroundWorkSink = Pick<typeof logger, "debug" | "info" | "warn" | "error">;
type BackgroundWorkEvent = { outcome: string; code?: string } & Record<string, unknown>;

/** Keep routine per-order results available at debug level. Failures and
 * retries remain visible at production's default info threshold. */
export function reportBackgroundWork(action: string, event: BackgroundWorkEvent, sink: BackgroundWorkSink = logger): void {
  const { code, ...fields } = event;
  const routine = (action === "shipping_package_history" || action === "order_action_projection")
    && (event.outcome === "published" || event.outcome === "superseded");
  const write = event.outcome === "failed" ? sink.error
    : event.outcome === "retry" || event.outcome === "review" ? sink.warn
      : routine ? sink.debug : sink.info;
  write(action, { ...fields, ...(code ? { error_code: code } : {}) });
}
