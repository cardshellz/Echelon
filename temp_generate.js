const { spawn } = require('child_process');
const p = spawn('npx.cmd', ['drizzle-kit', 'generate'], { cwd: 'c:\\Users\\owner\\Echelon' });

p.stdout.on('data', (d) => {
  const str = d.toString();
  process.stdout.write(str);
  // Drizzle asks: Is <table_name> table created or renamed from another table?
  // Or: Is <column_name> column created or renamed from another column?
  if (str.includes('created or renamed from another')) {
    // The default (first option) is ALWAYS 'create'. So sending Enter works.
    p.stdin.write('\r\n');
  }
});
p.stderr.on('data', (d) => process.stderr.write(d.toString()));
p.on('close', (code) => process.exit(code));
