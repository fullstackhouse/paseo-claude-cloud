# Claude (cloud) for Paseo

Adds a **Claude (cloud)** provider. Each agent runs in an Anthropic-hosted sandbox through the
[Managed Agents API](https://platform.claude.com/docs/en/managed-agents), so it uses none of your machine's CPU.

- **Setup:** in **Settings → Providers → Claude (cloud) → Configure** (or Settings → Plugins →
  Claude (cloud)), paste an Anthropic API key, or set `ANTHROPIC_API_KEY` in the daemon environment.
- **Billing:** API rates plus session runtime, not your Claude subscription. Every session has a hard
  dollar cap (default $2). When an agent reaches it, Paseo offers to raise the cap for that session.
- **Repository:** the workspace must be a GitHub repository whose current commit is on GitHub. The
  sandbox clones that commit with your `gh` token (or `MANAGED_AGENTS_GITHUB_TOKEN`).
- **Pushing and PRs (optional):** add a GitHub token on the same settings page, ideally a
  fine-grained token limited to the repositories you want. It's kept in an Anthropic vault and used
  only for GitHub's MCP server, and the sandbox never sees it. With it, cloud agents push branches
  and open PRs themselves; `git push` itself can't work there.
- **Local copy:** the agent also writes `changes.patch` and calls `sync_changes_to_local`; the daemon
  applies it to your worktree, so Paseo's diff view shows the change.
- **Host tools:** your Paseo MCP servers (asks, status, PRs, …) are offered to the cloud agent as
  custom tools that run in your daemon. Tools your host pre-approves run without asking; others ask
  first. The daemon must be running for those calls to complete.
- **Modes:** Auto (Anthropic's classifier approves safe calls, unclear ones ask you) or Ask (every
  sandbox and GitHub tool call asks you).
