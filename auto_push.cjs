const { spawn } = require('child_process');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const p = spawn('npx', ['drizzle-kit', 'push', '--force'], { cwd: 'c:\\Users\\owner\\Echelon', shell: true });

p.stdout.on('data', (d) => {
  const str = d.toString();
  process.stdout.write(str);
  if (str.includes('from another') || str.includes('Do you want to') || str.includes('truncate') || str.includes('drop')) {
    p.stdin.write('\r\n');
  }
});
p.stderr.on('data', (d) => process.stderr.write(d.toString()));
p.on('close', (code) => {
  console.log('✅ Auto-push complete!');
  process.exit(code);
});
