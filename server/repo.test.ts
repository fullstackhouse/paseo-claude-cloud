import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepo } from "./repo.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A bare "GitHub" remote with two commits on main, and a clone whose main is one commit behind. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "pcc-repo-"));
  const remote = join(root, "github.com", "acme", "app.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const author = join(root, "author");
  git(root, "clone", "-q", remote, author);
  const commit = (dir: string, name: string) => {
    writeFileSync(join(dir, name), name);
    git(dir, "add", name);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name);
  };
  commit(author, "a");
  git(author, "push", "-q", "origin", "HEAD:main");
  const local = join(root, "local");
  git(root, "clone", "-q", remote, local);
  commit(author, "b");
  git(author, "push", "-q", "origin", "HEAD:main");
  return { local, author, commit, tip: () => git(author, "rev-parse", "HEAD") };
}

describe("readRepo", () => {
  it("clones GitHub's tip when the local branch is only behind it", async () => {
    const { local, tip } = setup();
    const stale = git(local, "rev-parse", "HEAD");
    const repo = await readRepo(local);
    expect(repo.localSha).toBe(stale);
    expect(repo.sha).toBe(tip());
  });

  it("clones a feature branch off a stale main from GitHub's main", async () => {
    const { local, tip } = setup();
    git(local, "checkout", "-qb", "feature");
    expect((await readRepo(local)).sha).toBe(tip());
  });

  it("keeps the local commit when the branch has pushed commits of its own", async () => {
    const { local, commit } = setup();
    git(local, "checkout", "-qb", "feature");
    commit(local, "c");
    git(local, "push", "-q", "origin", "feature");
    const head = git(local, "rev-parse", "HEAD");
    expect((await readRepo(local)).sha).toBe(head);
  });
});
