import { Pool } from 'pg';

async function migrate() {
  const databaseUrl = process.env.EXTERNAL_DATABASE_URL;
  if (!databaseUrl) {
    console.error('EXTERNAL_DATABASE_URL is required');
    process.exit(1);
  }

  const pool = new Pool({ 
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log('Starting multi-location migration...');

    await pool.query(`
      ALTER TABLE product_locations 
      DROP CONSTRAINT IF EXISTS product_locations_catalog_product_id_unique;
    `);
    console.log('Dropped unique constraint on catalog_product_id');

    const locTypeCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'product_locations' AND column_name = 'location_type';
    `);
    if (locTypeCheck.rows.length === 0) {
      await pool.query(`
        ALTER TABLE product_locations 
        ADD COLUMN location_type VARCHAR(30) NOT NULL DEFAULT 'forward_pick';
      `);
      console.log('Added location_type column');
    } else {
      console.log('location_type column already exists');
    }

    const isPrimaryCheck = await pool.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'product_locations' AND column_name = 'is_primary';
    `);
    if (isPrimaryCheck.rows.length === 0) {
      await pool.query(`
        ALTER TABLE product_locations 
        ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 1;
      `);
      console.log('Added is_primary column');
    } else {
      console.log('is_primary column already exists');
    }

    console.log('Multi-location migration completed successfully!');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
