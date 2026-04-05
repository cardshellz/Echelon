import fs from 'fs';
const data = fs.readFileSync('schema_dump.json', 'utf16le');
const cleanData = data.replace(/^\uFEFF/, '');
const parsed = JSON.parse(cleanData);
const tables: Record<string, any[]> = {};
for (const row of parsed) {
  if (!tables[row.table_name]) tables[row.table_name] = [];
  tables[row.table_name].push(`${row.column_name}: ${row.data_type}`);
}
console.log(JSON.stringify(tables, null, 2));
