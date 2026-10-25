/** These guards run once in CI preflight. Local test:unit still includes them. */
export const CI_GUARD_TEST_FILES = Object.freeze([
  "server/__tests__/unit/money-read-boundaries.test.ts",
  "server/__tests__/unit/postgres-ci-shards.test.ts",
  "server/__tests__/unit/migration-prefix-collision.test.ts",
  "server/__tests__/unit/migration-allocation.test.ts",
  "server/__tests__/unit/migration-inherited-provenance.test.ts",
  "server/__tests__/unit/browser-ci-selection.test.ts",
  "server/__tests__/unit/dropship-browser-features.test.ts",
  "server/__tests__/unit/writer-ratchet.test.ts",
  "server/__tests__/unit/test-typecheck-ratchet.test.ts",
  "server/__tests__/unit/ci-fast-feedback.test.ts",
  "server/__tests__/unit/test-impact.test.ts",
]);
