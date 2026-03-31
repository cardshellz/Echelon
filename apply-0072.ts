import { Pool } from 'pg';
import { readFileSync } from 'fs';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sql = readFileSync('c:/Users/owner/Echelon/migrations/0072_override_priority_permission.sql', 'utf8');

pool.query(sql)
  .then(() => { 
    console.log('Successfully applied 0072_override_priority_permission.sql'); 
    process.exit(0); 
  })
  .catch(e => { 
    console.error('Failed to apply migration:', e); 
    process.exit(1); 
  });
