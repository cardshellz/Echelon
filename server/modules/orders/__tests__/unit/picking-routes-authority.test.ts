import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type RouteWiring = {
  method: string;
  path: string;
  guards: string[];
};

function parseRouteWirings(filePath: string): RouteWiring[] {
  const sourceText = readFileSync(resolve(process.cwd(), filePath), "utf8");
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const routes: RouteWiring[] = [];

  const describeGuard = (node: ts.Expression): string => {
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      if (fn === "limitPageRead") return "limitPageRead";
      const args = node.arguments.map(arg => arg.getText(source).replaceAll('"', "")).join(",");
      return `${fn}(${args})`;
    }
    return "handler";
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["get", "post", "patch", "put", "delete"].includes(node.expression.name.text)
    ) {
      const [firstArg, ...rest] = node.arguments;
      if (firstArg && ts.isStringLiteral(firstArg)) {
        routes.push({
          method: node.expression.name.text.toUpperCase(),
          path: firstArg.text,
          guards: rest.slice(0, -1).map(describeGuard),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return routes;
}

describe("WMS picking route capability wiring (Batch B1)", () => {
  const pickingRoutes = parseRouteWirings("server/modules/orders/picking.routes.ts");
  const pickingHistoryRoutes = parseRouteWirings("server/modules/orders/picking-history.routes.ts");

  it.each([
    ["GET", "/api/picking/queue", ["requireAuth", "requirePermission(picking,view)"]],
    ["GET", "/api/picking/orders/:id", ["requireAuth", "requirePermission(picking,view)"]],
    ["GET", "/api/picking/replen-bins", ["requireAuth", "requirePermission(picking,view)"]],
    ["POST", "/api/picking/replen-guidance", ["requireAuth", "requirePermission(picking,view)"]],
    ["POST", "/api/picking/orders/:id/claim", ["requireAuth", "requirePermission(orders,claim)"]],
    ["PATCH", "/api/picking/items/:id", ["requireAuth", "requirePermission(picking,perform)"]],
    ["POST", "/api/picking/items/:id/unpick", ["requireAuth", "requirePermission(picking,perform)"]],
    ["POST", "/api/picking/items/:id/resolve-allocation", ["requireAuth", "requirePermission(picking,perform)"]],
    ["POST", "/api/picking/items/:id/replen-source-empty", ["requireAuth", "requirePermission(picking,perform)"]],
    ["POST", "/api/picking/bin-count", ["requireAuth", "requirePermission(picking,perform)"]],
    ["POST", "/api/picking/orders/:id/ready-to-ship", ["requireAuth", "requirePermission(picking,complete)"]],
    ["POST", "/api/orders/:id/priority", ["requireAuth", "requirePermission(orders,priority)"]],
    ["GET", "/api/orders/exceptions", ["requireAuth", "requirePermission(orders,resolve_exception)"]],
    ["POST", "/api/orders/:id/resolve-exception", ["requireAuth", "requirePermission(orders,resolve_exception)"]],
    ["GET", "/api/picking/logs", ["requireAuth", "requirePermission(picking,view_logs)"]],
    ["GET", "/api/picking/orders/:id/timeline", ["requireAuth", "requirePermission(picking,view_logs)"]],
    ["GET", "/api/picking/logs/action-types", ["requireAuth", "requirePermission(picking,view_logs)"]],
    ["GET", "/api/picking/metrics", ["requireAuth", "requirePermission(picking,view_metrics)"]],
    ["GET", "/api/picking/debug", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["GET", "/api/picking/diagnose/:orderNumber", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["GET", "/api/picking/diagnose-overcounted", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["POST", "/api/picking/logs/backfill", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["POST", "/api/settings/order-combining", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["POST", "/api/orders/combine", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["POST", "/api/orders/combine-all", ["requireAuth", "requirePermission(picking,manage_settings)"]],
    ["POST", "/api/orders/:id/uncombine", ["requireAuth", "requirePermission(picking,manage_settings)"]],
  ])("enforces explicit capability %s %s -> %j", (method, path, expectedGuards) => {
    const match = pickingRoutes.find(route => route.method === method && route.path === path);
    expect(match?.guards).toEqual(expectedGuards);
  });

  it.each([
    ["GET", "/api/settings/order-combining"],
    ["GET", "/api/orders/combinable"],
    ["GET", "/api/orders/combined-groups"],
  ])("requires picking or orders read capability on %s %s", (method, path) => {
    const match = pickingRoutes.find(route => route.method === method && route.path === path);
    expect(match?.guards).toEqual([
      "requireAuth",
      "requireAnyPermission([picking, view],[picking, manage_settings],[orders, view])",
    ]);
  });

  it("enforces picking:view on GET /api/picking/history before page read limiting", () => {
    const match = pickingHistoryRoutes.find(route => route.method === "GET" && route.path === "/api/picking/history");
    expect(match?.guards).toEqual(["requireAuth", "requirePermission(picking,view)"]);
  });

  it("removes requireAssignedSystemRole from all /api/picking/* endpoints", () => {
    const pickingScoped = pickingRoutes.filter(route => route.path.startsWith("/api/picking/"));
    for (const route of pickingScoped) {
      expect(route.guards.some(guard => guard.startsWith("requireAssignedSystemRole"))).toBe(false);
    }
  });
});
