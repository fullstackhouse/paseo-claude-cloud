# Claude Managed Agents for Paseo

Adds a **Claude (cloud)** provider. Each agent runs in an Anthropic-hosted sandbox through the
[Managed Agents API](https://platform.claude.com/docs/en/managed-agents), so it uses none of your machine's CPU.

- **Billing:** API rates plus session runtime, not your Claude subscription. Every session has a hard
  dollar budget (default $2), set on the plugin's settings screen.
- **Setup:** paste an Anthropic API key and set the per-session spend cap in
  **Settings → Plugins → Claude Managed Agents** (or set `ANTHROPIC_API_KEY` in the daemon environment). The workspace must be a GitHub
  repository whose branch is pushed; the sandbox clones it with your `gh` token
  (or `MANAGED_AGENTS_GITHUB_TOKEN`).
- **Changes come back as a patch:** the agent writes `changes.patch` and calls
  `sync_changes_to_local`; the daemon applies it to your worktree, so Paseo's diff view shows it.
- **Host tools:** your Paseo MCP servers (asks, status, …) are offered to the cloud agent as
  custom tools that run in your daemon. The daemon must be running for those calls to complete.
- **Modes:** Auto (Anthropic's classifier approves safe calls, unclear ones ask you) or Ask (every
  sandbox tool call asks you).
