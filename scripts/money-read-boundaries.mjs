import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const coercions = new Set(["Number", "parseFloat", "Number.parseFloat", "parseInt", "Number.parseInt"]);
const moneyName = /(?:[Cc]ents|_cents|[Mm]ills|_mills|[Pp]rice|[Cc]ost|[Ss]aving|[Ss]ubtotal|minimumOrderAmount|orderTotal|totalSpent|totalCombinedValue|dollarsRaw)/;
const nonMoneyName = /(?:[Pp]ercent|[Mm]ultiplier|[Rr]atio|[Ww]eight|[Ll]ength|[Dd]ays|[Tt]axRate)/;

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
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (ts.isCallExpression(node) && coercions.has(node.expression.getText(ast)) && node.arguments.length) {
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
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (["__tests__", "test-fixtures", "dev", "node_modules"].includes(entry.name)) continue;
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!/\.ts$/.test(file) || /\.(test|spec)\.ts$/.test(file) || /^(verify-|test-)/.test(entry.name)) continue;
      for (const site of unsafeMoneyReads(await readFile(path.join(root, file), "utf8"), file)) {
        if (!allowed.some(rule => rule.file === file && rule.expression === site.expression && rule.reason.trim())) failures.push(site);
      }
    }
  }
  for (const directory of ["server", "shared", "scripts"]) await walk(directory);
  return failures;
}
