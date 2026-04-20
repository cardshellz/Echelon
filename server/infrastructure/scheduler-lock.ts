import { pool } from "../db";

/**
 * Executes a function exactly once across all active dynos
 * by utilizing a session-level Postgres advisory lock.
 * If the lock cannot be acquired (already held by another dyno),
 * the function returns null immediately without executing `fn`.
 * 
 * @param lockId A unique integer ID for this specific scheduled task
 * @param fn The async function to execute if the lock is acquired
 */
export async function withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    // Try to acquire the lock. Returns true if acquired, false otherwise.
    const result = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId]);
    if (!result.rows[0].acquired) {
      console.log(`[AdvisoryLock] Lock ${lockId} is already held by another worker. Skipping execution.`);
      return null;
    }

    // Execute the user function
    return await fn();
  } catch (err: any) {
    console.error(`[AdvisoryLock] Error running locked function for ${lockId}:`, err.message);
    throw err;
  } finally {
    // Always release the lock before returning connection to pool
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(e => {
      console.error(`[AdvisoryLock] Failed to release lock ${lockId}:`, e.message);
    });
    client.release();
  }
}
