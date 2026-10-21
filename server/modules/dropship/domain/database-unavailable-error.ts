/**
 * Whether a failure means the database connection was unavailable, not that a
 * statement was wrong. Pure: it reads only the error's shape. Most of these carry
 * no SQLSTATE: node-postgres reports a pool that cannot hand out a client in time,
 * a dropped socket or a client whose connection is gone by message or by the
 * socket's own code.
 *
 * The same taxonomy as the finance read transaction's "database unavailable"
 * branch (infrastructure/dropship-finance-read-transaction.ts
 * financeCodeForDatabaseError); keep the two in step.
 */

/** Node socket codes for a connection that could not be made or was lost. */
export const DATABASE_SOCKET_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
]);

/**
 * PostgreSQL SQLSTATEs of an unavailable server: 57P01 admin shutdown (a
 * failover), 57P02 crash shutdown, 57P03 cannot connect now, 53300 too many
 * connections. Class 08 (connection exception) is matched by prefix.
 */
export const DATABASE_UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set(["57P01", "57P02", "57P03", "53300"]);

/** node-postgres's message when the pool cannot hand out a client before connectionTimeoutMillis. */
const POOL_CONNECT_TIMEOUT_MESSAGE = "timeout exceeded when trying to connect";
/** node-postgres's message for a socket that closed under a client ("Connection terminated unexpectedly", "... due to connection timeout"). */
const CONNECTION_TERMINATED_MESSAGE = /Connection terminated/i;
/** node-postgres's message for any statement sent on a client whose connection is gone. */
const CLIENT_NOT_QUERYABLE_MESSAGE = /is not queryable/;

export function isDatabaseUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (DATABASE_SOCKET_ERROR_CODES.has(code) || DATABASE_UNAVAILABLE_SQLSTATES.has(code)) return true;
    if (/^08[0-9A-Z]{3}$/.test(code)) return true;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;
  return message.includes(POOL_CONNECT_TIMEOUT_MESSAGE) || CONNECTION_TERMINATED_MESSAGE.test(message)
    || CLIENT_NOT_QUERYABLE_MESSAGE.test(message);
}
