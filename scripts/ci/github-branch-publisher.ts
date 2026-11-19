/**
 * Commits a small set of files to one branch of a GitHub repository through
 * the REST API (git blobs, tree, commit, ref), so a job with no git checkout
 * can publish them. Used by scripts/publish-production-structure.ts.
 *
 * Each call adds one commit whose tree is exactly the given files. The branch
 * only ever moves forward (no force), so its history is a record of every
 * publication. Running it twice publishes twice, which is harmless.
 *
 * Errors are classified:
 *   transient  network failure, HTTP 429 or 5xx: retried with a growing delay
 *   permanent  any other HTTP error (bad token, missing permission, rejected
 *              update): not retried, because repeating it cannot succeed
 */
import { CheckError } from "./disposable-database";

export const GITHUB_API_ORIGIN = "https://api.github.com";
/** Attempts per API call, counting the first. */
export const GITHUB_REQUEST_ATTEMPTS = 3;
/** Wait before the second attempt; each later wait grows by the same amount. */
export const GITHUB_RETRY_BASE_DELAY_MS = 2_000;
const GITHUB_API_VERSION = "2022-11-28";
const REGULAR_FILE_MODE = "100644";
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_FLOOR = 500;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface GitHubResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type GitHubFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<GitHubResponse>;

export interface PublishInput {
  fetchImpl: GitHubFetch;
  delay: (ms: number) => Promise<void>;
  token: string;
  /** "owner/name" */
  repository: string;
  branch: string;
  /** path -> UTF-8 text */
  files: Readonly<Record<string, string>>;
  message: string;
}

export interface PublishResult {
  commitSha: string;
  /** false when this publication created the branch */
  branchExisted: boolean;
}

function stringField(value: unknown, field: string, step: string): string {
  const found = (value as Record<string, unknown> | null)?.[field];
  if (typeof found !== "string" || found === "") {
    throw new CheckError("GITHUB_PUBLISH_UNEXPECTED_RESPONSE", `GitHub's reply to "${step}" has no ${field}.`, { step });
  }
  return found;
}

export async function publishFilesToBranch(input: PublishInput): Promise<PublishResult> {
  const { fetchImpl, delay, token, repository, branch, files, message } = input;
  const paths = Object.keys(files).sort();
  if (token.trim() === "" || !REPOSITORY_NAME.test(repository) || !BRANCH_NAME.test(branch) || paths.length === 0 || message.trim() === "") {
    throw new CheckError("GITHUB_PUBLISH_INPUT_INVALID", "Publishing needs a token, an owner/name repository, a branch, a message and at least one file.");
  }
  const base = `${GITHUB_API_ORIGIN}/repos/${repository}`;

  /** One API call. Returns null for a 404 when `missingAllowed`. */
  async function call(step: string, method: string, path: string, body: unknown, missingAllowed = false): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      let response: GitHubResponse | null = null;
      try {
        response = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // A network failure. The error text is not passed on: it can quote request details.
      }
      if (response?.ok) return response.json();
      if (response && response.status === HTTP_NOT_FOUND && missingAllowed) return null;
      const transient = response === null || response.status === HTTP_TOO_MANY_REQUESTS || response.status >= HTTP_SERVER_ERROR_FLOOR;
      if (!transient) {
        throw new CheckError("GITHUB_PUBLISH_REJECTED", `GitHub refused "${step}" (HTTP ${response!.status}). Check the token's permission on ${repository}.`, {
          step, status: response!.status, errorClass: "permanent",
        });
      }
      if (attempt >= GITHUB_REQUEST_ATTEMPTS) {
        throw new CheckError("GITHUB_PUBLISH_UNAVAILABLE", `GitHub could not be reached for "${step}" after ${attempt} attempts.`, {
          step, status: response?.status ?? null, errorClass: "transient",
        });
      }
      await delay(GITHUB_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  const ref = await call("read branch", "GET", `/git/ref/heads/${branch}`, undefined, true);
  const parentSha = ref === null ? null : stringField((ref as { object?: unknown }).object, "sha", "read branch");

  const tree: Array<{ path: string; mode: string; type: "blob"; sha: string }> = [];
  for (const path of paths) {
    const blob = await call(`upload ${path}`, "POST", "/git/blobs", {
      content: Buffer.from(files[path], "utf8").toString("base64"),
      encoding: "base64",
    });
    tree.push({ path, mode: REGULAR_FILE_MODE, type: "blob", sha: stringField(blob, "sha", `upload ${path}`) });
  }
  const treeSha = stringField(await call("create tree", "POST", "/git/trees", { tree }), "sha", "create tree");
  const commitSha = stringField(await call("create commit", "POST", "/git/commits", {
    message, tree: treeSha, parents: parentSha === null ? [] : [parentSha],
  }), "sha", "create commit");

  if (parentSha === null) {
    await call("create branch", "POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commitSha });
  } else {
    await call("move branch", "PATCH", `/git/refs/heads/${branch}`, { sha: commitSha, force: false });
  }
  return { commitSha, branchExisted: parentSha !== null };
}
