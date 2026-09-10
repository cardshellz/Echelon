import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Procurement loads the real application. App eagerly imports all pages, so even
// an unrelated page can break startup. Preserve that full runtime dependency
// graph; narrowing procurement to route-specific pages would be unsafe today.
export const BROWSER_SUITES = {
  procurement: {
    config: "playwright.procurement.config.ts",
    workflow: ".github/workflows/procurement-navigation.yml",
    tests: /^test\/browser\/procurement-.*\.ts$/,
    roots: ["client/src/main.tsx"],
    ownedPrefixes: ["client/src/features/purchasing/", "client/src/features/po-edit/", "client/src/components/purchasing/"],
  },
  dropship: {
    config: "playwright.dropship-pricing.config.ts",
    workflow: ".github/workflows/dropship-pricing.yml",
    tests: /^test\/browser\/(?:dropship-(?:pricing|content|policy)-.*\.ts|dropship-shipping-estimate\.spec\.ts|shared-shipping-configuration\.spec\.ts)$/,
    // These modules are injected by mocked HTML, not imported by the specs.
    roots: [
      "dropship-pricing", "dropship-content", "dropship-policy", "dropship-shipping-estimate",
      "shared-shipping-configuration",
    ].map((harness) => `test/browser/fixtures/${harness}-harness.tsx`),
    ownedPrefixes: ["client/src/pages/dropship/", "client/src/components/shipping/", "server/modules/dropship/"],
  },
};

const GLOBAL_PREFIXES = [
  "shared/", "client/src/components/ui/", "client/src/components/layout/",
  "client/src/hooks/", "client/src/lib/", "client/src/styles/", "client/public/",
  "attached_assets/", "scripts/ci/",
];
const GLOBAL_FILES = new Set([
  "client/src/App.tsx", "client/src/main.tsx", "client/index.html", "client/src/index.css",
  "package.json", "package-lock.json", ".npmrc", ".nvmrc", "tsconfig.json", "vitest.config.ts",
]);
const KNOWN_NON_BROWSER_PREFIXES = ["server/", "migrations/", "docs/", "scripts/", ".github/"];
const KNOWN_FEATURE_PREFIXES = ["client/src/pages/", "client/src/features/", "client/src/components/"];
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

export function parseChangedFiles(output) {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^(?:[AMD]|[RC]\d+)$/.test(status ?? "")) throw new Error("Unrecognized git change status");
    const count = /^[RC]/.test(status) ? 2 : 1;
    const paths = fields.slice(index, index + count);
    if (paths.length !== count || paths.some((file) => !file || file.startsWith("/") || file.split("/").includes(".."))) {
      throw new Error("Malformed changed-file record");
    }
    changes.push({ status, paths });
    index += count;
  }
  return changes;
}

function importsIn(source, filename) {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if (ast.parseDiagnostics.length) throw new Error(`Cannot parse ${filename}`);
  const imports = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteralLike(node.moduleSpecifier)) throw new Error(`Unknown import in ${filename}`);
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (!expression || !ts.isStringLiteralLike(expression)) throw new Error(`Unknown import in ${filename}`);
      imports.push(expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      imports.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
    )) {
      if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0])) {
        throw new Error(`Dynamic import cannot be resolved in ${filename}`);
      }
      imports.push(node.arguments[0].text);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text.startsWith("glob")) {
      throw new Error(`Glob import cannot be resolved in ${filename}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return imports;
}

function resolveLocalImport(from, specifier, files, packages) {
  let target;
  const clean = specifier.replace(/[?#].*$/, "");
  if (clean.startsWith("@/")) target = `client/src/${clean.slice(2)}`;
  else if (clean.startsWith("@shared/")) target = `shared/${clean.slice(8)}`;
  else if (clean.startsWith("@assets/")) target = `attached_assets/${clean.slice(8)}`;
  else if (clean.startsWith(".")) target = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  else if (clean.startsWith("/") || clean.startsWith("~") || clean.startsWith("#")) {
    throw new Error(`Unknown local import ${specifier} in ${from}`);
  } else {
    const packageName = clean.startsWith("@") ? clean.split("/").slice(0, 2).join("/") : clean.split("/")[0];
    if (builtinModules.includes(clean.replace(/^node:/, "")) || packages.has(packageName)) return null;
    throw new Error(`Unknown package or alias ${specifier} in ${from}`);
  }
  const candidates = [target, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"].map((ext) => target + ext),
    ...[".ts", ".tsx", ".js", ".jsx"].map((ext) => `${target}/index${ext}`)];
  if (/\.[cm]?jsx?$/.test(target)) candidates.push(target.replace(/\.[cm]?jsx?$/, ".ts"), target.replace(/\.[cm]?jsx?$/, ".tsx"));
  const resolved = candidates.find((candidate) => files.has(candidate));
  if (!resolved) throw new Error(`Unresolved import ${specifier} in ${from}`);
  return resolved;
}

export function dependencyClosure(roots, files, readSource) {
  const manifest = JSON.parse(readSource("package.json"));
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    if (!files.has(file)) throw new Error(`Missing suite entrypoint ${file}`);
    visited.add(file);
    if (!SOURCE_EXTENSION.test(file)) continue;
    for (const specifier of importsIn(readSource(file), file)) {
      const imported = resolveLocalImport(file, specifier, files, packages);
      if (imported) pending.push(imported);
    }
  }
  return visited;
}

function sharedShellRoots(files, readSource) {
  const app = "client/src/App.tsx";
  if (!files.has(app)) throw new Error("Missing application shell");
  const manifest = JSON.parse(readSource("package.json"));
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  return importsIn(readSource(app), app)
    .map((specifier) => resolveLocalImport(app, specifier, files, packages))
    .filter((file) => file && !file.startsWith("client/src/pages/"));
}

export function selectBrowserSuite({ suite, changes, files, readSource, force = false, definitions = BROWSER_SUITES }) {
  if (!Object.hasOwn(definitions, suite)) throw new Error(`Unknown browser suite: ${suite}`);
  const config = definitions[suite];
  const run = (reason) => ({ run: true, reason });
  if (force) return run("Manual dispatch requests complete coverage");
  if (!changes.length) return run("No changed-file evidence; run conservatively");
  try {
    // An old dependency may no longer be in the HEAD graph. Never use that graph
    // to skip a deletion, rename, or copy, regardless of destination ownership.
    if (changes.some((change) => !["A", "M"].includes(change.status))) return run("Deleted, renamed, or copied path");
    const changed = changes.flatMap((change) => change.paths);
    for (const file of changed) {
      if (!files.has(file)) return run(`Changed path is missing: ${file}`);
      if (GLOBAL_FILES.has(file) || GLOBAL_PREFIXES.some((prefix) => file.startsWith(prefix))
        || /^(?:vite|tailwind|postcss|playwright)[^/]*\.[cm]?[jt]s$/.test(file)
        || /\.(?:css|scss|sass|less)$/.test(file)) return run(`Shared UI or toolchain: ${file}`);
      if (file === config.config || file === config.workflow || config.tests.test(file)
        || config.ownedPrefixes.some((prefix) => file.startsWith(prefix))) return run(`Suite-owned path: ${file}`);
    }
    const testRoots = [...files].filter((file) => config.tests.test(file));
    if (!testRoots.length) return run("No suite tests discovered");
    const graph = dependencyClosure([...config.roots, ...testRoots, ...sharedShellRoots(files, readSource)], files, readSource);
    for (const file of changed) {
      if (graph.has(file)) return run(`Transitive suite dependency: ${file}`);
      if (KNOWN_FEATURE_PREFIXES.some((prefix) => file.startsWith(prefix))
        || KNOWN_NON_BROWSER_PREFIXES.some((prefix) => file.startsWith(prefix))
        || /^test\/browser\/(?:procurement-|dropship-)/.test(file)
        || /^(?:README|AGENTS|LICENSE)(?:\.[^/]*)?$/.test(file)) continue;
      return run(`Unclassified path: ${file}`);
    }
    return { run: false, reason: "Only known paths outside this suite's dependency graph changed" };
  } catch (error) {
    return run(`Dependency analysis was uncertain: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

export function runSelection(environment = process.env, root = process.cwd()) {
  const suite = environment.BROWSER_SUITE;
  if (!Object.hasOwn(BROWSER_SUITES, suite ?? "")) throw new Error("BROWSER_SUITE must name a configured suite");
  let selection;
  try {
    if (environment.BROWSER_EVENT_NAME === "workflow_dispatch") {
      selection = { run: true, reason: "Manual dispatch requests complete coverage" };
    } else {
      const base = environment.BROWSER_BASE_SHA;
      const head = environment.BROWSER_HEAD_SHA;
      if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) throw new Error("Missing or invalid commit SHA");
      const changes = parseChangedFiles(git(root, ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`, "--"]));
      const files = new Set(git(root, ["ls-files", "-z"]).split("\0").filter(Boolean));
      selection = selectBrowserSuite({ suite, changes, files,
        readSource: (file) => readFileSync(path.join(root, file), "utf8") });
    }
  } catch (error) {
    selection = { run: true, reason: `Selection evidence unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  console.log(JSON.stringify({ suite, ...selection }));
  if (environment.GITHUB_OUTPUT) appendFileSync(environment.GITHUB_OUTPUT, `run=${selection.run}\n`);
  return selection;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runSelection();
