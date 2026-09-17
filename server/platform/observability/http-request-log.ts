import type { RequestHandler } from "express";
import { logger } from "./logger";

export interface HttpRequestLog {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  completed: boolean;
}

/** Metadata only: never wrap res.json or retain/serialize its response body.
 * The old capture kept every successful page's object graph alive until finish,
 * and serialized error bodies a second time merely to truncate the log line.
 */
export function createHttpRequestLogger(
  write: (entry: HttpRequestLog) => void = entry => logger.info("http.request_completed", { ...entry }),
  now: () => number = () => performance.now(),
): RequestHandler {
  return (req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const start = now();
    // Bound untrusted URL metadata too; no query strings, cookies or payloads.
    const method = req.method.slice(0, 16);
    const path = req.path.slice(0, 255).replace(/[\r\n\t]/g, " ");
    const complete = () => {
      res.off("finish", complete);
      res.off("close", complete);
      write({ method, path, status: res.statusCode,
        durationMs: Math.max(0, Math.round(now() - start)), completed: res.writableFinished });
    };
    res.once("finish", complete);
    res.once("close", complete);
    next();
  };
}
