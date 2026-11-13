import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const NOTIFICATIONS_DIR = resolve(ROOT, "server/modules/notifications");

const ALLOWED_NOTIFICATIONS_ENTRYPOINTS = new Set([
  "index",
  "index.ts",
  "in-app-notifications.api",
  "in-app-notifications.api.ts",
  "email-delivery.api",
  "email-delivery.api.ts",
  "routes.api",
  "routes.api.ts",
]);

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function collectModuleSpecifiers(filePath: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const expr = node.expression;
      if (
        expr.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expr) && expr.text === "require") ||
        (ts.isPropertyAccessExpression(expr) &&
          ts.isIdentifier(expr.expression) &&
          expr.expression.text === "vi" &&
          (expr.name.text === "mock" || expr.name.text === "doMock"))
      ) {
        specifiers.push(node.arguments[0].text);
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return specifiers;
}

function checkNotificationsSpecifier(fromFile: string, specifier: string): string | null {
  let targetRelToNotifications: string | null = null;

  if (specifier.startsWith(".")) {
    const resolvedTarget = resolve(fromFile, "..", specifier);
    const rel = relative(NOTIFICATIONS_DIR, resolvedTarget).split(sep).join("/");
    if (!rel.startsWith("..") && !rel.startsWith("/")) {
      targetRelToNotifications = rel === "" ? "index" : rel;
    }
  } else if (specifier.includes("modules/notifications")) {
    const idx = specifier.indexOf("modules/notifications");
    const after = specifier.slice(idx + "modules/notifications".length).replace(/^\/+/, "");
    targetRelToNotifications = after === "" ? "index" : after;
  }

  if (targetRelToNotifications === null) return null;
  if (ALLOWED_NOTIFICATIONS_ENTRYPOINTS.has(targetRelToNotifications)) return null;

  const repoRelFrom = relative(ROOT, fromFile).split(sep).join("/");
  return `${repoRelFrom} -> "${specifier}" (resolves to notifications/${targetRelToNotifications})`;
}

describe("NTF-2 Priority 14 Notifications CI-03 internal API boundaries & writer ratchets", () => {
  it("blocks all external deep imports and vi.mock bypasses into server/modules/notifications internals", () => {
    const roots = ["server", "scripts", "shared", "client", "test"].map((d) => resolve(ROOT, d));
    const allFiles = roots.flatMap((r) => walkTsFiles(r));
    const violations: string[] = [];

    for (const file of allFiles) {
      const relToNotifications = relative(NOTIFICATIONS_DIR, file).split(sep).join("/");
      const isInsideNotifications =
        !relToNotifications.startsWith("..") && !relToNotifications.startsWith("/");
      if (isInsideNotifications) continue;

      const content = readFileSync(file, "utf8");
      if (!content.includes("notifications")) continue;

      for (const specifier of collectModuleSpecifiers(file, content)) {
        const violation = checkNotificationsSpecifier(file, specifier);
        if (violation) violations.push(violation);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps notifications barrel and .api.ts facades strictly layered and non-speculative", () => {
    const indexSource = readFileSync(resolve(NOTIFICATIONS_DIR, "index.ts"), "utf8");
    expect(indexSource).toContain("./in-app-notifications.api");
    expect(indexSource).toContain("./email-delivery.api");
    expect(indexSource).toContain("./routes.api");
    expect(indexSource).not.toContain("./notifications.service");
    expect(indexSource).not.toContain("./email.service");
    expect(indexSource).not.toContain("./notifications.routes");

    const inAppSource = readFileSync(resolve(NOTIFICATIONS_DIR, "in-app-notifications.api.ts"), "utf8");
    expect(inAppSource).not.toMatch(/getUserNotifications|markRead|markAllRead|setUserPreference|resetUserPreferences/);
  });

  it("locks sole-writer ownership for public.notifications and public.notification_preferences", () => {
    const baseline = JSON.parse(
      readFileSync(resolve(ROOT, "scripts/writer-ratchet/baseline.json"), "utf8"),
    ) as Record<string, string[]>;
    expect(baseline["public.notifications"]).toEqual(["modules/notifications"]);
    expect(baseline["public.notification_preferences"]).toEqual(["modules/notifications"]);

    const routeAndScript = JSON.parse(
      readFileSync(resolve(ROOT, "scripts/writer-ratchet/route-and-script-baseline.json"), "utf8"),
    ) as {
      routeWriters: Record<string, Record<string, string[]>>;
      scriptWriters: Record<string, Record<string, string[]>>;
    };

    const leakingRoutes = Object.entries(routeAndScript.routeWriters)
      .filter(([, tables]) => "public.notifications" in tables || "public.notification_preferences" in tables)
      .map(([file]) => file);
    const leakingScripts = Object.entries(routeAndScript.scriptWriters)
      .filter(([, tables]) => "public.notifications" in tables || "public.notification_preferences" in tables)
      .map(([file]) => file);

    expect(leakingRoutes).toEqual([]);
    expect(leakingScripts).toEqual([]);
  });
});
