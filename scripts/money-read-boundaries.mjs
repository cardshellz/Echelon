import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const coercions = new Set(["Number", "parseFloat", "Number.parseFloat", "parseInt", "Number.parseInt"]);
const moneyName = /(?:[Cc]ents|_cents|[Mm]ills|_mills|[Pp]rice|[Cc]ost|[Ss]aving|[Ss]ubtotal|minimumOrderAmount|orderTotal|totalSpent|totalCombinedValue|dollarsRaw)/;
const nonMoneyName = /(?:[Pp]ercent|[Mm]ultiplier|[Rr]atio|[Ww]eight|[Ll]ength|[Dd]ays|[Tt]axRate)/;
const possibleCoercion = /\b(?:Number\s*(?:\.\s*parse(?:Float|Int))?|parse(?:Float|Int))\s*\(/;

function coercionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
    return `${node.expression.text}.${node.name.text}`;
  return "";
}

function valueNames(node) {
  if (ts.isPropertyAccessExpression(node)) return [node.name.text];
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteral(node.argumentExpression) ? [node.argumentExpression.text] : [];
  }
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isCallExpression(node)) return node.arguments.flatMap(valueNames);
  const names = [];
  ts.forEachChild(node, child => { names.push(...valueNames(child)); });
  return names;
}

/** Bounded source guard, not a substitute for tracing field units. It catches
 * coercions of declared monetary fields and float-to-cent multiplication.
 * Exact BigInt/Decimal calculations and non-money rates keep their own policy.
 */
export function unsafeMoneyReads(source, filename) {
  // Most source files contain no numeric coercion. Avoid allocating an AST
  // for them when this guard runs beside the rest of CI.
  if (!possibleCoercion.test(source)) return [];
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node) && coercions.has(coercionName(node.expression)) && node.arguments.length) {
      const monetary = valueNames(node.arguments[0]).some(name =>
        moneyName.test(name) && !nonMoneyName.test(name) && !/(?:_id|Id|_version|Version|_provisional)$/.test(name));
      const nonMoney = valueNames(node.arguments[0]).some(name => nonMoneyName.test(name));
      let parent = node.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      const scaledToCents = ts.isBinaryExpression(parent)
        && parent.operatorToken.kind === ts.SyntaxKind.AsteriskToken
        && [parent.left.getText(ast), parent.right.getText(ast)].includes("100");
      if (monetary || (scaledToCents && !nonMoney)) {
        failures.push({ file: filename, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
          expression: node.getText(ast) });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return failures;
}

export async function auditMoneyReadBoundaries(root, allowed) {
  const failures = [];
  const files = [];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (["__tests__", "test-fixtures", "dev", "node_modules"].includes(entry.name)) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.ts$/.test(file) || /\.(test|spec)\.ts$/.test(file) || /^(verify-|test-)/.test(entry.name)) continue;
      files.push(file);
    }
  }
  for (const directory of ["server", "shared", "scripts"]) await walk(directory);
  // Bounded I/O avoids a serial open/read round-trip for every source file,
  // without loading the whole repository or exhausting file handles.
  const batchSize = 16;
  files.sort();
  for (let start = 0; start < files.length; start += batchSize) {
    const batch = files.slice(start, start + batchSize);
    const sources = await Promise.all(batch.map(file => readFile(path.join(root, file), "utf8")));
    for (let index = 0; index < batch.length; index++) {
      for (const site of unsafeMoneyReads(sources[index], batch[index])) {
        if (!allowed.some(rule => rule.file === site.file && rule.expression === site.expression && rule.reason.trim())) failures.push(site);
      }
    }
  }
  return failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
