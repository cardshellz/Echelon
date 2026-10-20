import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";
import { fail, parseAllocatedFilename, readMigrationInventory, validateMigrationInventory } from "./migration-policy.mjs";

const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_FOREIGN_PRS = 20;
const MAX_API_BYTES = 1024 * 1024;
const API_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 30_000;

function git(repositoryRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Cannot read inherited migration history. Fetch the recorded commits and full history before retrying.", { command: args[0] });
  }
}

function allocatedPath(file) {
  let filename;
  if (/^migrations\/[^/]+\.sql$/.test(file)) filename = file.slice("migrations/".length);
  else if (/^migrations\/metadata\/[^/]+\.sql\.json$/.test(file)) filename = file.slice("migrations/metadata/".length, -".json".length);
  if (!filename) return null;
  const allocation = parseAllocatedFilename(filename);
  return allocation ? { filename, pr: allocation.pr } : null;
}

function migrationTree(repositoryRoot, commit) {
  const entries = git(repositoryRoot, ["ls-tree", "-r", "-z", commit, "--", "migrations"]).split("\0").filter(Boolean);
  const tree = new Map();
  for (const entry of entries) {
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entry);
    if (!match) fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Malformed migration tree evidence.");
    tree.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  return tree;
}

function foreignAllocations(repositoryRoot, context, baseTree) {
  const inventory = readMigrationInventory(path.join(repositoryRoot, "migrations"));
  const filenames = validateMigrationInventory(inventory);
  const foreign = new Map();
  function collect(filename, owner) {
    // History already present on the verified synthetic merge base is protected
    // by the ordinary immutable-history check and needs no remote provenance.
    if (owner === context.pr || baseTree.has("migrations/" + filename)) return;
    const owned = foreign.get(owner) ?? new Set();
    owned.add(filename);
    foreign.set(owner, owned);
    if (foreign.size > MAX_FOREIGN_PRS) {
      fail("MIGRATION_PROVENANCE_LIMIT", "Too many foreign migration owners to verify in one check. Update the PR from its base before retrying.", { maximum: MAX_FOREIGN_PRS });
    }
  }
  for (const filename of filenames) {
    const record = inventory.metadata.get(filename);
    if (record) collect(filename, record.pr);
  }
  // Inspect introductions, including merge resolutions, even when the working
  // tree deleted every foreign pair or renamed it into the current PR namespace.
  // A scan of only today's files would allow that immutable history to disappear.
  const introduced = git(repositoryRoot, [
    "log", "--format=", "--name-only", "-z", "--diff-filter=A", "--no-renames",
    "--full-history", "--diff-merges=first-parent", context.base + ".." + context.head, "--", "migrations",
  ]).split("\0");
  for (const item of introduced) {
    const file = item.replace(/^\n+/, "");
    if (!file) continue;
    const allocation = allocatedPath(file);
    if (allocation) collect(allocation.filename, allocation.pr);
  }
  return foreign;
}

function repositoryIdentity(environment, eventRepository) {
  const repository = environment.GITHUB_REPOSITORY;
  if (typeof repository !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
      || [".", ".."].includes(repository.split("/")[1])
      || typeof eventRepository !== "string" || eventRepository.toLowerCase() !== repository.toLowerCase()) {
    fail("MIGRATION_PROVENANCE_UNAVAILABLE", "The GitHub event repository must match the configured repository before inherited migration owners can be verified.");
  }
  const token = environment.GITHUB_TOKEN;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || /[\s\x00-\x1f\x7f]/.test(token)) {
    fail("MIGRATION_PROVENANCE_UNAVAILABLE", "A GitHub token with pull-request read access is required to verify inherited migrations.");
  }
  return { repository, token };
}

async function readPullRequest(fetchImpl, repository, token, owner) {
  let response;
  let payload;
  try {
    response = await fetchImpl("https://api.github.com/repos/" + repository + "/pulls/" + owner, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (response.status !== 200 || response.redirected || !response.body) throw new Error("Unavailable API response.");
    const declaredSize = response.headers.get("content-length");
    if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_API_BYTES)) throw new Error("Response exceeds evidence limit.");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_API_BYTES) {
          await reader.cancel();
          throw new Error("Response exceeds evidence limit.");
        }
        chunks.push(Buffer.from(next.value));
      }
    } finally {
      reader.releaseLock();
    }
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Neither exceptions, response bodies, nor request headers are logged:
    // transport failures can contain request credentials or remote text.
    fail("MIGRATION_PROVENANCE_UNAVAILABLE", "Cannot verify the inherited migration's owning pull request with GitHub. Check API access and retry.", { ownerPr: owner });
  }
  const validMergeCommit = typeof payload?.merge_commit_sha === "string"
    && COMMIT_SHA.test(payload.merge_commit_sha) && !/^0+$/.test(payload.merge_commit_sha);
  if (!payload || payload.number !== owner || typeof payload.merged !== "boolean"
      || !["open", "closed"].includes(payload.state)
      || typeof payload.base?.repo?.full_name !== "string"
      || payload.base.repo.full_name.toLowerCase() !== repository.toLowerCase()
      || (payload.merged && (payload.state !== "closed" || !validMergeCommit))
      || (!payload.merged && payload.merge_commit_sha !== null && !validMergeCommit)) {
    fail("MIGRATION_OWNER_NOT_MERGED", "Inherited migrations require valid evidence for the exact owning pull request in this repository.", { ownerPr: owner });
  }
  return { merged: payload.merged, mergeCommit: payload.merge_commit_sha };
}

function requireAncestor(repositoryRoot, merge, head, owner) {
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", merge, head], {
    cwd: repositoryRoot, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  });
  if (ancestry.error || ![0, 1].includes(ancestry.status)) {
    fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Cannot verify the owning PR's merge ancestry. Fetch full history before retrying.", { ownerPr: owner });
  }
  if (ancestry.status !== 0) {
    fail("MIGRATION_INHERITED_NOT_ANCESTOR", "The owning PR's verified merge commit must be an ancestor of the event's PR head.", { ownerPr: owner });
  }
}

function requireUnchangedFile(repositoryRoot, file, source, headTree, checkoutTree, owner) {
  const head = headTree.get(file);
  const checkout = checkoutTree.get(file);
  if (!source || source.type !== "blob" || !["100644", "100755"].includes(source.mode)
      || !head || head.oid !== source.oid || head.mode !== source.mode
      || !checkout || checkout.oid !== source.oid || checkout.mode !== source.mode) {
    fail("MERGED_MIGRATION_IMMUTABLE", "An inherited owning PR's SQL or metadata was changed, renamed, or deleted: " + file + ".", { file, ownerPr: owner });
  }
  let regular = false;
  try {
    const info = lstatSync(path.join(repositoryRoot, file));
    regular = info.isFile() && !info.isSymbolicLink();
  } catch { /* Report the same immutable-history failure for a missing file. */ }
  if (!regular) fail("MERGED_MIGRATION_IMMUTABLE", "An inherited migration file is missing or unsafe: " + file + ".", { file, ownerPr: owner });
  // Compare Git's canonical blob bytes, applying the path's checkout filters so
  // CRLF on Windows cannot masquerade as a content change or require SQL edits.
  const workingOid = git(repositoryRoot, ["hash-object", "--path=" + file, "--", file]).trim();
  if (workingOid !== source.oid) {
    fail("MERGED_MIGRATION_IMMUTABLE", "The checkout changed an inherited migration file: " + file + ".", { file, ownerPr: owner });
  }
}

function allocationAbsent(repositoryRoot, filename, headTree, checkoutTree) {
  const pair = ["migrations/" + filename, "migrations/metadata/" + filename + ".json"];
  return pair.every((file) => {
    if (headTree.has(file) || checkoutTree.has(file)) return false;
    try { lstatSync(path.join(repositoryRoot, file)); return false; }
    catch (error) {
      if (error?.code === "ENOENT") return true;
      fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Cannot establish whether a historical migration file is absent.", { file });
    }
  });
}

/** Called only after strict local CI context and inventory checks have succeeded. */
export async function verifyInheritedMigrationFiles(repositoryRoot, context, environment, dependencies = {}) {
  // A shallow boundary could hide an introduction followed by deletion, leaving
  // no live foreign filename. Absence is trustworthy only with complete history.
  if (git(repositoryRoot, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    fail("MIGRATION_GIT_EVIDENCE_UNAVAILABLE", "Inherited migration auditing requires full Git history; fetch with depth zero before retrying.");
  }
  const baseTree = migrationTree(repositoryRoot, context.base);
  const foreign = foreignAllocations(repositoryRoot, context, baseTree);
  if (foreign.size === 0) return new Set();
  const { repository, token } = repositoryIdentity(environment, context.eventRepository);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail("MIGRATION_PROVENANCE_UNAVAILABLE", "GitHub API access is unavailable in this Node runtime.");
  const headTree = migrationTree(repositoryRoot, context.head);
  const checkoutTree = migrationTree(repositoryRoot, "HEAD");
  const verified = new Set();
  for (const [owner, observed] of [...foreign].sort(([left], [right]) => left - right)) {
    const evidence = await readPullRequest(fetchImpl, repository, token, owner);
    if (!evidence.merged) {
      // The allocator permits readopting an unmerged draft. GitHub must confirm
      // that owner is still unmerged, and neither old file may survive anywhere.
      if ([...observed].every((filename) => allocationAbsent(repositoryRoot, filename, headTree, checkoutTree))) continue;
      fail("MIGRATION_OWNER_NOT_MERGED", "A present foreign migration requires its owning pull request to be merged.", { ownerPr: owner });
    }
    const merge = evidence.mergeCommit;
    requireAncestor(repositoryRoot, merge, context.head, owner);
    const sourceTree = migrationTree(repositoryRoot, merge);
    const owned = new Set();
    for (const file of sourceTree.keys()) {
      const allocation = allocatedPath(file);
      if (allocation?.pr === owner) owned.add(allocation.filename);
    }
    // An unmerged allocation can be readopted before its owner merges. Ignore
    // that historical name only when neither half survives in any checked tree
    // or on disk. Every actual file at the verified merge is still immutable.
    for (const filename of observed) {
      if (!owned.has(filename)) {
        if (!allocationAbsent(repositoryRoot, filename, headTree, checkoutTree)) {
          fail("MIGRATION_PR_OWNERSHIP", "The foreign migration does not exist in its owning PR's verified merge: " + filename + ".", { filename, expectedPr: context.pr, ownerPr: owner });
        }
      }
    }
    // Enumerate the verified merge, not current files: a deleted sibling must
    // fail even if another genuine migration from that owner remains unchanged.
    for (const filename of owned) {
      for (const file of ["migrations/" + filename, "migrations/metadata/" + filename + ".json"]) {
        requireUnchangedFile(repositoryRoot, file, sourceTree.get(file), headTree, checkoutTree, owner);
      }
      verified.add(filename);
    }
  }
  return verified;
}
