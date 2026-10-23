import { execFileSync } from "node:child_process";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;
const SNAPSHOT_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;

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

export function importsIn(source, filename) {
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
      && ts.isIdentifier(node.expression.expression) && ["vi", "jest"].includes(node.expression.expression.text)
      && ["mock", "doMock"].includes(node.expression.name.text)) {
      if (!node.arguments.length || !ts.isStringLiteralLike(node.arguments[0])) throw new Error(`Unknown mock import in ${filename}`);
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

export function resolveLocalImport(from, specifier, files, packages) {
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

export function dependencyClosure(roots, files, readSource, edges = new Map()) {
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
    if (!edges.has(file)) {
      const source = readSource(file);
      const dependencies = [];
      // Browser specs inject these modules into mocked HTML instead of importing.
      for (const match of source.matchAll(/["']((?:test\/browser\/fixtures|client\/src)\/[^"'\r\n]+\.[cm]?[jt]sx?)["']/g)) {
        if (!files.has(match[1])) throw new Error("Missing injected source: " + match[1]);
        dependencies.push(match[1]);
      }
      for (const specifier of importsIn(source, file)) {
        const imported = resolveLocalImport(file, specifier, files, packages);
        if (imported) dependencies.push(imported);
      }
      // Store only complete evidence, never a partial parse after an exception.
      edges.set(file, dependencies);
    }
    pending.push(...edges.get(file));
  }
  return visited;
}


export function hasUncertainImpact(decision) {
  // An unfamiliar positive reason is uncertainty, never proof of narrow impact.
  return decision.run && !/^(?:Full coverage requested|Shared UI or toolchain:|Suite-owned path:|Transitive suite dependency:)/.test(decision.reason);
}

/** Shared decision owner. Adapters supply coverage roots and scope rules; an
 * inability to prove independence always selects the suite. */
export function selectTestImpact({ changes, files, readSource, previous, force = false, coverage, dependencyCache = new Map() }) {
  const run = reason => ({ run: true, reason });
  if (force) return run("Full coverage requested");
  if (!Array.isArray(changes) || !changes.length) return run("No changed-file evidence; run conservatively");
  try {
    const paths = [];
    for (const change of changes) {
      const records = parseChangedFiles(change.status + "\0" + change.paths.join("\0") + "\0");
      if (records.length !== 1) throw new Error("Malformed changed-file evidence");
      if (!["A", "M"].includes(change.status) && !previous) return run("Dependency history unavailable");
      const oldPaths = change.status === "D" ? change.paths : /^[RC]/.test(change.status) ? [change.paths[0]] : [];
      const newPaths = change.status === "D" ? [] : /^[RC]/.test(change.status) ? [change.paths[1]] : change.paths;
      for (const file of oldPaths) if (!previous.files.has(file)) return run("Previous changed path is missing: " + file);
      for (const file of newPaths) if (!files.has(file)) return run("Changed path is missing: " + file);
      paths.push(...change.paths);
    }
    for (const file of paths) {
      if (coverage.globalFiles.includes(file) || coverage.globalPrefixes.some(prefix => file.startsWith(prefix))
          || coverage.globalPattern?.test(file)) return run("Shared UI or toolchain: " + file);
      if (coverage.ownedFiles.includes(file) || coverage.ownedPrefixes.some(prefix => file.startsWith(prefix))
          || coverage.testPattern.test(file)) return run("Suite-owned path: " + file);
    }
    for (const snapshot of [ { files, readSource }, ...(previous ? [previous] : []) ]) {
      const tests = [...snapshot.files].filter(file => coverage.testPattern.test(file));
      if (!tests.length) return run("No suite tests discovered");
      const roots = coverage.roots(snapshot);
      if (!dependencyCache.has(snapshot.readSource)) dependencyCache.set(snapshot.readSource, new Map());
      const graph = dependencyClosure([...roots, ...tests], snapshot.files, snapshot.readSource, dependencyCache.get(snapshot.readSource));
      for (const file of paths) if (graph.has(file)) return run("Transitive suite dependency: " + file);
    }
    for (const file of paths) {
      if (coverage.knownPrefixes.some(prefix => file.startsWith(prefix)) || coverage.knownPattern?.test(file)) continue;
      return run("Unclassified path: " + file);
    }
    return { run: false, reason: "Only known paths outside this suite's dependency graph changed" };
  } catch (error) {
    return run("Dependency analysis was uncertain: " + (error instanceof Error ? error.message : String(error)));
  }
}

function git(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, maxBuffer: MAX_GIT_OUTPUT_BYTES, ...options });
}
function readTree(root, ref) {
  const tree = new Map();
  for (const record of git(root, ["ls-tree", "-r", "-z", ref]).toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unsupported Git tree entry");
    tree.set(match[3], { mode: match[1], oid: match[2] });
  }
  return tree;
}
/** Read immutable Git blobs in one batch. Never evaluate source, follow symlinks,
 * or use a dirty working copy as evidence for excluding CI coverage. */
export function readGitSnapshots(root, refs) {
  if (!refs.length || refs.some(ref => !/^[a-f0-9]{40}$/.test(ref))) throw new Error("Invalid snapshot commit");
  const trees = refs.map(ref => readTree(root, ref));
  const ids = [...new Set(trees.flatMap(tree => [...tree].filter(([file, entry]) =>
    SNAPSHOT_SOURCE_EXTENSION.test(file) && entry.mode !== "120000").map(([,entry]) => entry.oid)))];
  const blobs = new Map();
  if (ids.length) {
    const output = git(root, ["cat-file", "--batch"], { input: ids.join("\n") + "\n" });
    let offset = 0;
    for (const id of ids) {
      const end = output.indexOf(10, offset);
      if (end < 0) throw new Error("Incomplete Git blob header");
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(output.subarray(offset, end).toString("utf8"));
      if (!match || match[1] !== id) throw new Error("Unexpected Git blob identity");
      const size = Number(match[2]);
      const start = end + 1;
      if (!Number.isSafeInteger(size) || start + size >= output.length || output[start + size] !== 10)
        throw new Error("Incomplete Git blob");
      blobs.set(id, output.subarray(start, start + size).toString("utf8"));
      offset = start + size + 1;
    }
    if (offset !== output.length) throw new Error("Unexpected trailing Git data");
  }
  return trees.map((tree, index) => ({
    ref: refs[index], files: new Set(tree.keys()), readSource(file) {
      const entry = tree.get(file);
      if (!entry || entry.mode === "120000" || !blobs.has(entry.oid)) throw new Error("Unavailable source snapshot: " + file);
      return blobs.get(entry.oid);
    },
  }));
}

export function readTestChangeEvidence(environment, root) {
  const base = environment.CI_BASE_SHA ?? environment.BROWSER_BASE_SHA;
  const head = environment.CI_HEAD_SHA ?? environment.BROWSER_HEAD_SHA;
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ""))) throw new Error("Missing or invalid commit SHA");
  const mergeBase = git(root, ["merge-base", base, head]).toString("utf8").trim();
  const tested = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim();
  if (tested !== head) {
    const parents = git(root, ["show", "-s", "--format=%P", tested]).toString("utf8").trim().split(" ");
    if (parents.length !== 2 || !parents.includes(head) || !parents.includes(base))
      throw new Error("Checkout is neither the requested head nor its exact test merge");
  }
  const changes = parseChangedFiles(git(root, ["diff", "--name-status", "-z", "--find-renames", mergeBase, tested, "--"]).toString("utf8"));
  const [previous, current] = readGitSnapshots(root, [mergeBase, tested]);
  return { changes, previous, ...current };
}
