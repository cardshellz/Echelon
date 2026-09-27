type ReturnSuite = "authorization" | "access" | "inspection" | "intake";

const CI_DATABASE_NAME = /^\/echelon_ci_s[1-8]_[0-9a-f]{32}$/;
const LOCAL_DATABASE_NAMES: Record<ReturnSuite, RegExp> = {
  authorization: /^\/returns_portal_test(?:_[a-z0-9]+)?$/,
  access: /^\/returns_access_test(?:_[a-z0-9]+)?$/,
  inspection: /^\/returns_inspection_test(?:_[a-z0-9]+)?$/,
  intake: /^\/returns_intake_test(?:_[a-z0-9]+)?$/,
};
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

/** Select only this suite's database or the fresh database owned by the CI runner. */
export function resolveReturnsTestDatabase(env: NodeJS.ProcessEnv, suite: ReturnSuite): string | null {
  const shared = env.ECHELON_TEST_DATABASE_URL;
  let ciOwned = false;
  if (shared) {
    try { ciOwned = CI_DATABASE_NAME.test(new URL(shared).pathname); } catch { /* Validate selected URL below. */ }
  }
  // A CI process owns a fresh DB for one file. A stale local access override must
  // never redirect that process to a shared database while CI reports isolation.
  const raw = ciOwned || suite === "authorization" ? shared
    : suite === "inspection" ? env.RETURNS_INSPECTION_TEST_DATABASE_URL
      : suite === "intake" ? env.RETURNS_INTAKE_TEST_DATABASE_URL : env.RETURNS_ACCESS_TEST_DATABASE_URL;
  if (!raw) return null;
  if (env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") throw unsafeDatabase();
  let url: URL;
  try { url = new URL(raw); } catch { throw unsafeDatabase(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !LOOPBACK_HOSTS.includes(url.hostname)
    || (!LOCAL_DATABASE_NAMES[suite].test(url.pathname) && !CI_DATABASE_NAME.test(url.pathname))
    || url.search !== "" || url.hash !== "") throw unsafeDatabase();
  // Compare database identity, not credentials or URL spelling. node-postgres
  // accepts query overrides, so no query options are accepted above.
  for (const configured of [env.DATABASE_URL, env.EXTERNAL_DATABASE_URL]) {
    if (!configured) continue;
    let application: URL;
    try { application = new URL(configured); } catch { throw unsafeDatabase(); }
    if (LOOPBACK_HOSTS.includes(application.hostname)
      && (application.port || "5432") === (url.port || "5432")
      && application.pathname === url.pathname) throw unsafeDatabase();
  }
  return raw;
}

function unsafeDatabase(): Error {
  return new Error("Returns integration tests require an explicitly disposable local suite database or a database owned by the PostgreSQL CI runner.");
}
