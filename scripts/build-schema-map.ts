import * as fs from 'fs';
import * as path from 'path';

const schemaDir = path.join(import.meta.dirname, '../shared/schema');
const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.schema.ts'));

const tableMap: Record<string, string> = {};

for (const file of files) {
  const content = fs.readFileSync(path.join(schemaDir, file), 'utf-8');
  
  // Find pgTable("table_name", ...)
  const pgTableRegex = /pgTable\s*\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = pgTableRegex.exec(content)) !== null) {
    const tableName = match[1];
    const logicalSchema = file.replace('.schema.ts', '');
    tableMap[tableName] = logicalSchema;
  }
}

// Generate markdown
let md = "# Comprehensive Echelon Database Schema Map\n\n";

const schemas: Record<string, string[]> = {};
for (const [table, schema] of Object.entries(tableMap)) {
  if (!schemas[schema]) schemas[schema] = [];
  schemas[schema].push(table);
}

for (const [schema, tables] of Object.entries(schemas).sort()) {
  md += `## \`${schema}\` Domain\n`;
  md += "> Target Namespace: `" + schema + "`\n\n";
  for (const table of tables) {
    md += `- \`public.${table}\` → **MOVE TO** \`${schema}.${table}\`\n`;
  }
  md += "\n";
}

fs.writeFileSync(path.join(import.meta.dirname, '../schema-map.md'), md);
console.log("Mapped schema successfully to schema-map.md");
