import ts from "typescript";
import { importsIn, resolveLocalImport } from "./test-impact.mjs";

/** Select journey entrypoints from the actual router in each Git snapshot.
 * App import/startup coverage is owned separately by the required bootstrap job.
 * Dynamic/pathless routes stay shared: we cannot prove their URL ownership.
 * Unsupported or incomplete router evidence throws so the caller runs broadly.
 */
export function appRouteRoots({ files, readSource }, prefixes) {
  const file = "client/src/App.tsx";
  if (!files.has(file)) throw new Error("Missing application router");
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.some(prefix => typeof prefix !== "string" || !/^\/[\w/-]+$/.test(prefix)))
    throw new Error("Invalid application route scope");
  const ast = ts.createSourceFile(file, readSource(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (ast.parseDiagnostics.length) throw new Error("Cannot parse application router");
  const manifest = JSON.parse(readSource("package.json"));
  const packages = new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }));
  const imports = new Map();
  const declarations = new Map();
  let routeName;
  for (const statement of ast.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteralLike(statement.moduleSpecifier)) throw new Error("Unknown router import");
      const specifier = statement.moduleSpecifier.text;
      const target = resolveLocalImport(file, specifier, files, packages);
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, target);
      if (clause?.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const binding of clause.namedBindings.elements) {
            imports.set(binding.name.text, target);
            if (specifier === "wouter" && (binding.propertyName ?? binding.name).text === "Route")
              routeName = binding.name.text;
          }
        } else imports.set(clause.namedBindings.name.text, target);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      }
    }
  }
  if (!routeName) throw new Error("Application Route import is unavailable");
  const defaultExport = ast.statements.find(statement => ts.isExportAssignment(statement) && !statement.isExportEquals
    || statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword));
  if (!defaultExport) throw new Error("Application default export is unavailable");
  const routeOpening = node => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    return opening && ts.isIdentifier(opening.tagName) && opening.tagName.text === routeName ? opening : null;
  };
  const roots = new Set();
  function collectReferences(entrypoint, pruneRoutes = false) {
    const visited = new Set();
    function references(node) {
      if (pruneRoutes && routeOpening(node)) return;
      if (ts.isIdentifier(node)) {
        const name = node.text;
        const imported = imports.get(name);
        if (imported) roots.add(imported);
        // Local wrappers can choose between pages (e.g. feature flags).
        // Follow declarations without evaluating application code.
        if (!visited.has(name) && declarations.has(name)) {
          visited.add(name);
          references(declarations.get(name));
        }
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        for (const specifier of importsIn(node.getText(ast), file)) {
          const imported = resolveLocalImport(file, specifier, files, packages);
          if (imported) roots.add(imported);
        }
      }
      ts.forEachChild(node, references);
    }
    references(entrypoint);
  }
  // Page-like hosts can render beside the Switch, outside every Route (e.g.
  // authenticated channel hosts). Follow App's runtime references with Route
  // subtrees pruned so these remain common without pulling in every page.
  collectReferences(defaultExport, true);
  let matched = 0;
  function visit(node) {
    const opening = routeOpening(node);
    if (opening) {
      if (opening.attributes.properties.some(ts.isJsxSpreadAttribute)) throw new Error("Unknown spread Route attributes");
      const attribute = opening.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(ast) === "path");
      const initializer = attribute?.initializer;
      const expression = initializer && ts.isJsxExpression(initializer) ? initializer.expression : initializer;
      const routePath = expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
      const owned = routePath !== undefined && prefixes.some(prefix => routePath === prefix || routePath.startsWith(prefix + "/"));
      if (owned) matched++;
      if (owned || routePath === undefined) collectReferences(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!matched || !roots.size) throw new Error("No application routes resolved for the requested scope");
  return [...roots].sort();
}
