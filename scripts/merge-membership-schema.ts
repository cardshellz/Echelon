import * as fs from 'fs';
import * as path from 'path';

const targetFile = path.join(import.meta.dirname, '../shared/schema/membership.schema.ts');
const sourceFile = path.join(import.meta.dirname, '../scripts/membership-schema-dump.ts');

const targetContent = fs.readFileSync(targetFile, 'utf8');
const sourceContent = fs.readFileSync(sourceFile, 'utf8');

// First check if it already contains one of the tables so we don't append twice
if (!targetContent.includes('export const accessRules = membershipSchema.table("access_rules"')) {
  fs.writeFileSync(targetFile, targetContent + '\n' + sourceContent);
  console.log("Appended Drizzle definitions successfully.");
} else {
  console.log("Definitions are already present in membership.schema.ts - skipped.");
}
