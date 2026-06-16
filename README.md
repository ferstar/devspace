# DevSpace

Expose a secure local coding workspace through a Streamable HTTP MCP server.

DevSpace connects MCP-capable hosts such as ChatGPT or Claude to a local
development machine. The host calls MCP tools directly; work is not delegated to
a separate local agent loop.

## Tool Naming Modes

Default tool naming is controlled by `DEVSPACE_TOOL_NAMING`.

Legacy naming, the current default:

- `open_workspace`
- `read_file`
- `write_file`
- `edit_file`
- `grep_files`
- `find_files`
- `list_directory`
- `run_shell`

Short naming, enabled with `DEVSPACE_TOOL_NAMING=short`:

- `open_workspace`
- `read`
- `write`
- `edit`
- `grep`
- `glob`
- `ls`
- `bash`

Set `DEVSPACE_TOOL_MODE=minimal` to disable the dedicated search/list tools. In
that mode, the server instructs clients to use the shell tool with command-line
programs such as `grep`, `rg`, `find`, `ls`, and `tree` for search and directory
inspection.

`DEVSPACE_WIDGETS` controls ChatGPT Apps widget iframe usage. `changes`, the
default, exposes `review_changes` and only attaches widget UI to `open_workspace`
and that aggregate review tool. Use `full` to restore legacy per-tool cards for
debugging without the aggregate review tool, or `off` to disable widget UI entirely.

Server-level workflow guidance is exposed through MCP initialize instructions,
not a dedicated info tool.

## Persistent Result Payloads

Tool result payloads are persisted in a global SQLite database under
`~/.local/share/devspace/devspace.sqlite`, or under `DEVSPACE_STATE_DIR` when
that variable is set. This lets UI cards such as edit/write diff viewers reload
historical payloads after the MCP server process restarts.

Workspace IDs remain live-session identifiers; after a restart, open the
workspace again for new file, edit, search, or shell tool calls.

## Workspace Flow

Call `open_workspace` before using the coding tools:

```json
{
  "path": "~/personal/my-project"
}
```

Absolute paths such as `/home/waishnav/personal/my-project` are also supported.
By default, DevSpace opens the actual checkout. For isolated parallel work in an
existing Git repository, request a managed worktree:

```json
{
  "path": "~/personal/my-project",
  "mode": "worktree"
}
```

Managed worktrees are created under `~/.devspace/worktrees` by default, with
paths such as `~/.devspace/worktrees/my-project-a7f3c9d2`. Worktree mode requires
an initialized Git repository with at least one commit. It does not copy
uncommitted source checkout changes in the first version; the tool result notes
when the source checkout was dirty.

The result includes a `workspaceId`. Use that `workspaceId` for subsequent
calls:

```json
{
  "workspaceId": "ws_...",
  "path": "README.md"
}
```

When a workspace opens, the server loads global and workspace-root context files
such as `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD`. It also returns
nested instruction file paths in `availableAgentsFiles`. Later file, list,
search, edit, write, and shell calls do not inject nested instructions
automatically; the model should use the read tool to inspect a listed nested
instruction file before working under that path.

```json
{
  "agentsFiles": [{ "path": "AGENTS.md", "content": "..." }],
  "availableAgentsFiles": [{ "path": "apps/web/AGENTS.md" }]
}
```

## Skills

Skills are disabled by default. Set `DEVSPACE_SKILLS=1` to expose Agent Skills
through `open_workspace` output. DevSpace uses Pi's skill loader to discover
skills from `DEVSPACE_AGENT_DIR` (`~/.pi/agent` by default), project `.pi/skills`,
and optional comma-separated `DEVSPACE_SKILL_PATHS` for locations such as
`~/.agents/skills`, `~/.codex/skills`, or `~/.claude/skills`.

When enabled, `open_workspace` returns a structured catalog of skill names,
descriptions, and readable `SKILL.md` paths. The model should use the normal
read tool to load a matching skill path before following that skill. Skill paths
may be outside the workspace, but read access is limited to advertised `SKILL.md`
files and files under a skill directory after that skill's `SKILL.md` has been
read.

## Run Locally

DevSpace requires Node `>=20.12 <27`; Node 22 LTS is the recommended runtime.

```bash
npm install --include=dev
npm run typecheck
npm run build
npm run start
```

The CLI creates first-run config when needed:

```bash
devspace init
devspace serve
```

`devspace init` uses an interactive, one-question-at-a-time setup flow for the
project roots, local port, and optional stable public URL.

The default config files are:

```text
~/.devspace/config.json
~/.devspace/auth.json
```

`auth.json` contains the generated Owner password used by the local approval
screen. Keep it private. You will need that password when ChatGPT or Claude asks
you to approve DevSpace access.

For temporary tunnel or reverse-proxy URLs, keep the URL out of persistent
config and pass it for that run:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://your-temporary-host.example.com" devspace serve
```

For stable public URLs, persist it once:

```bash
devspace config set publicBaseUrl https://devspace.example.com
devspace serve
```

DevSpace derives the inbound Host allowlist from the resolved public URL, so
most users do not need to configure `DEVSPACE_ALLOWED_HOSTS`.

Use `devspace doctor` to inspect the resolved config, Node version, Node ABI,
platform, public URL, allowed hosts, and SQLite native dependency status.

For env-driven development without persisted config:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)" \
DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
DEVSPACE_WORKTREE_ROOT="/home/waishnav/.devspace/worktrees" \
DEVSPACE_SKILLS="1" \
DEVSPACE_SKILL_PATHS="/home/waishnav/.codex/skills,/home/waishnav/.claude/skills" \
DEVSPACE_TOOL_MODE="full" \
DEVSPACE_TOOL_NAMING="legacy" \
DEVSPACE_WIDGETS="changes" \
npm run dev
```

## Release Builds

Use release builds for long-running MCP server processes:

```bash
npm run release:build

env \
  DEVSPACE_OAUTH_OWNER_TOKEN="your-long-random-owner-token" \
  DEVSPACE_ALLOWED_ROOTS="/home/waishnav/personal,/home/waishnav/work" \
  DEVSPACE_PUBLIC_BASE_URL="https://devspace.example.com" \
  DEVSPACE_WORKTREE_ROOT="/home/waishnav/.devspace/worktrees" \
  DEVSPACE_TOOL_MODE="minimal" \
  DEVSPACE_TOOL_NAMING="short" \
  npm run release:start
```

The `DEVSPACE_*` assignments must be part of the same command invocation, or
exported first. Running each assignment as a separate shell command will not pass
those values to `npm run release:start`.

`release:build` runs the normal build, copies the built `dist/` tree into a new
`releases/<release-id>/dist` directory, and updates `releases/current` to point
at that immutable copy. A server already running from `npm run release:start`
continues to use its existing release while normal development builds can keep
rewriting `dist/`.

The regular `npm run build` and `npm run start` commands are still useful for
local development and smoke testing. For production-style long-running servers,
prefer `release:build` followed by restarting `release:start`.

The MCP endpoint is:

```text
http://127.0.0.1:7676/mcp
```

DevSpace now uses an embedded single-user OAuth flow instead of the old static
`DEVSPACE_TOKEN` bearer-token check. MCP clients discover OAuth metadata from:

```text
/.well-known/oauth-protected-resource/mcp
/.well-known/oauth-authorization-server
```

When ChatGPT opens the authorization URL, DevSpace shows a local Owner password
approval screen. Enter the generated Owner password there to approve the
connection. The issued OAuth access token is short-lived, resource-bound to the
configured `/mcp` endpoint, and must be sent by the MCP client as a normal
`Authorization: Bearer <oauth-access-token>` header.

## Cloudflare Tunnel

DevSpace does not create or manage tunnels. Point your tunnel, reverse proxy, or
public ingress at the local server:

```text
http://127.0.0.1:7676
```

Then start DevSpace with that public origin:

```bash
DEVSPACE_PUBLIC_BASE_URL="https://your-tunnel-hostname.example.com" devspace serve
```

Configure the remote MCP client with:

```text
https://your-tunnel-hostname.example.com/mcp
```

If your tunnel URL changes every run, pass the new URL through
`DEVSPACE_PUBLIC_BASE_URL` for that run instead of saving it in config.

## Security Notes

This server exposes local filesystem and shell capabilities. Treat it like
remote code execution on this machine.

- Let `devspace init` generate the Owner password, or set a long random
  `DEVSPACE_OAUTH_OWNER_TOKEN` for env-driven deployments.
- Keep `DEVSPACE_ALLOWED_ROOTS` narrow.
- `DEVSPACE_ALLOWED_HOSTS` is derived from `DEVSPACE_PUBLIC_BASE_URL` by default.
  Use `DEVSPACE_ALLOWED_HOSTS=*` only for local debugging when you intentionally
  want to disable Host header allowlist protection.
- Put Cloudflare Access or equivalent in front of the tunnel before exposing it when possible; OAuth still protects the MCP endpoint if the tunnel URL leaks.
- The shell tool can escape filesystem allowlists by design; shell access relies
  on authentication and client trust, not path containment.
