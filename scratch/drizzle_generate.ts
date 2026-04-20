import { spawn } from 'child_process';

const child = spawn('npx', ['drizzle-kit', 'generate'], {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: true
});

const interval = setInterval(() => {
  try {
    child.stdin.write('\n');
  } catch (e) {
    clearInterval(interval);
  }
}, 500);

child.on('exit', (code) => {
  clearInterval(interval);
  console.log('Exited with code: ', code);
});
