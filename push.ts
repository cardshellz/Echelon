import 'dotenv/config';
import { execSync } from 'child_process';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
console.log('Pushing schema to DB...');
try {
  execSync('npx drizzle-kit push --force', { stdio: 'inherit' });
  console.log('✅ Push complete!');
} catch (e) {
  console.error('❌ Push failed');
  process.exit(1);
}
