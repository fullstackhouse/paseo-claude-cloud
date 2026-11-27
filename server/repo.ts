import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface RepoInfo {
  url: string;
  branch: string;
  /** The commit the sandbox clones. */
  sha: string;
  /** The local HEAD. Differs from `sha` when the local branch is behind GitHub. */
  localSha: string;
}

/**
 * The workspace's GitHub remote and current commit. The branch itself need not be on GitHub:
 * a fresh workspace branch off main has no commits of its own, so its HEAD is already there.
 */
export async function readRepo(cwd: string): Promise<RepoInfo> {
  const remote = (await git(cwd, ["remote", "get-url", "origin"])).trim();
  const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) throw new Error(`The workspace remote is not a GitHub repository: ${remote}`);
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  await git(cwd, ["fetch", "--quiet", "origin"]).catch(() => "");
  const containing = (await git(cwd, ["branch", "-r", "--contains", sha]).catch(() => "")).trim();
  if (!containing) {
    throw new Error(
      `Commit ${sha.slice(0, 9)} on "${branch}" is not on GitHub yet. Push it first: the cloud agent clones from GitHub.`,
    );
  }
  return { url: `https://github.com/${match[1]}`, branch, sha: await freshBase(cwd, branch, sha), localSha: sha };
}

/**
 * A local branch that is only behind GitHub (no commits of its own) would start the agent on stale
 * code, so the sandbox clones the remote tip instead: `origin/<branch>`, else the default branch.
 */
async function freshBase(cwd: string, branch: string, sha: string): Promise<string> {
  const defaultRef = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  for (const ref of [`refs/remotes/origin/${branch}`, defaultRef]) {
    if (!ref) continue;
    const tip = (await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "")).trim();
    if (!tip) continue;
    if (tip === sha) return sha;
    const behind = await git(cwd, ["merge-base", "--is-ancestor", sha, tip]).then(() => true, () => false);
    if (behind) return tip;
  }
  return sha;
}

/** The current local HEAD, to check a patch from the sandbox still fits the worktree. */
export async function localHead(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

/** Token used only for the clone. Anthropic keeps it outside the sandbox. */
export async function readGitHubToken(env: Readonly<Record<string, string>>): Promise<string> {
  const fromEnv = env.MANAGED_AGENTS_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const { stdout } = await run("gh", ["auth", "token"], { env: { ...process.env, ...env } });
  return stdout.trim();
}

/** Applies a patch produced in the sandbox to the local worktree so Paseo's diff view shows it. */
export async function applyPatch(
  cwd: string,
  patch: string,
  { reverse = false }: { reverse?: boolean } = {},
): Promise<string> {
  const args = ["apply", "--whitespace=nowarn", ...(reverse ? ["--reverse"] : ["--3way"]), "-"];
  await gitWithInput(cwd, args, patch);
  return (await git(cwd, ["diff", "--stat", "HEAD"])).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function gitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve();
    });
    child.stdin?.end(input);
  });
}
