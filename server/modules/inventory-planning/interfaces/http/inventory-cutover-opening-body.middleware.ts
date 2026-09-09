import express, { type RequestHandler } from "express";

/** Complete opening verification may cover many stock positions. The ceiling is
 * limited to these authenticated commands; ordinary JSON keeps its 100KB limit. */
export const OPENING_JSON_LIMIT_BYTES = 10 * 1024 * 1024;
const paths = new Set([
  "/api/inventory-planning/admin/cutover-opening/preview",
  "/api/inventory-planning/admin/cutover-opening/verify",
]);
const parser = express.json({ limit: OPENING_JSON_LIMIT_BYTES });

export function isInventoryCutoverOpeningBulkJsonRequest(method: string, path: string): boolean {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return method.toUpperCase() === "POST" && paths.has(normalized);
}

/** Register only after permission middleware so unauthorized callers cannot ask
 * the server to allocate and parse a complete inventory verification document. */
export const parseInventoryCutoverOpeningJson: RequestHandler = (req, res, next) => {
  parser(req, res, (error?: unknown) => {
    if (error === undefined) return next();
    const type = error instanceof Error && "type" in error ? error.type : undefined;
    if (type === "entity.too.large") return res.status(413).json({ error: {
      code: "CUTOVER_OPENING_REQUEST_TOO_LARGE",
      message: "The complete opening verification exceeds the 10MB safety limit. No partial verification was accepted.",
    } });
    if (type === "entity.parse.failed") return res.status(400).json({ error: {
      code: "CUTOVER_OPENING_JSON_INVALID", message: "The opening verification document is not valid JSON.",
    } });
    return next(error);
  });
};
