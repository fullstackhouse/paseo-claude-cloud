# Claude (cloud) for Paseo

Adds a **Claude (cloud)** provider. Each agent runs in an Anthropic-hosted sandbox through the
[Managed Agents API](https://platform.claude.com/docs/en/managed-agents), so it uses none of your machine's CPU.

- **Setup:** in **Settings → Providers → Claude (cloud) → Configure** (or Settings → Plugins →
  Claude (cloud)), paste an Anthropic API key, or set `ANTHROPIC_API_KEY` in the daemon environment.
- **Billing:** API rates plus session runtime, not your Claude subscription. Every session has a hard
  dollar cap (default $10). When an agent reaches it, Paseo offers to raise the cap for that session.
- **Repository:** the workspace must be a GitHub repository whose current commit is on GitHub. The
  sandbox clones it with your `gh` token (or `MANAGED_AGENTS_GITHUB_TOKEN`). When the local branch is
  only behind GitHub (no commits of its own), it clones GitHub's tip instead: `origin/<branch>`, else the
  default branch, so a stale checkout never starts the agent on old code.
- **Pushing, PRs and CI:** agents push with plain `git push`, which Anthropic's git proxy authenticates
  with the clone token. `gh` is installed in the sandbox with `GH_TOKEN` set to a placeholder; the vault
  swaps in your token only on requests to GitHub's API, so the sandbox never sees it. Agents open PRs
  (stacked ones with `--base`), watch `gh pr checks` and read failed job logs themselves. GitHub's MCP
  server is offered too. The token is your `gh` login; to limit which repositories agents can touch,
  paste a fine-grained token (Contents and Pull requests: write, Actions: read) on the settings page.
- **Network:** package registries, `repo.yarnpkg.com`, GitHub and its log hosts are reachable. Add
  others (e.g. `*.example.dev` for PR previews) under **Extra hosts** on the settings page.
- **Local copy:** the agent also writes `changes.patch` and calls `sync_changes_to_local`; the daemon
  applies it to your worktree, so Paseo's diff view shows the change. It skips that when your worktree
  is on a different commit than the sandbox started from, rather than leave conflict markers.
- **Host tools:** your Paseo MCP servers (asks, status, PRs, …) are offered to the cloud agent as
  custom tools that run in your daemon. Tools your host pre-approves run without asking; others ask
  first. The daemon must be running for those calls to complete.
- **Debugging:** the context window popover (the ring by the composer) shows the agent's Anthropic
  session ID with Copy and a link to its page in the Claude Console, where the full event log is.
- **Modes:** Auto (Anthropic's classifier approves safe calls, unclear ones ask you) or Ask (every
  sandbox and GitHub tool call asks you).
