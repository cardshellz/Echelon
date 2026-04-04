import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false} });

async function run() {
  const mResult = await pool.query("SELECT * FROM membership.members WHERE email ILIKE '%cadman%'");
  const member = mResult.rows[0];

  const pResult = member ? await pool.query("SELECT * FROM membership.plans WHERE id = $1", [member.plan_id]) : {rows:[]};
  const plan = pResult.rows[0];

  const subR = member ? await pool.query("SELECT * FROM membership.member_subscriptions WHERE member_id = $1", [member.id]) : {rows:[]};
  
  const contractR = member ? await pool.query("SELECT * FROM membership.subscription_contracts WHERE member_id = $1", [member.id]) : {rows:[]};

  const output = {
    member: member,
    plan: plan?.name,
    member_subscriptions: subR.rows,
    subscription_contracts: contractR.rows
  };

  fs.writeFileSync('c:/Users/owner/Echelon/sub_result.json', JSON.stringify(output, null, 2));

  process.exit(0);
}
run();
