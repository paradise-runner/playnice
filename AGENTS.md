# AGENTS.md

Instructions for a coding agent working in or with this repository.

## Using playnice as a tool

You are likely here because you need to iterate on a CLI or TUI. The loop is:

```sh
playnice open --id app --cols 100 --rows 30 -- <command>   # start it
playnice key app Down                                       # act once
playnice send app "npm test"                                # act, with Enter
playnice snap app                                           # look, without acting
playnice wait app --text "Done" --timeout 120000            # slow work
playnice shot app -o /tmp/app.png                           # when pixels matter
playnice close app
```

Rules of thumb:

- **One action per look.** Every action returns the settled screen; read it before deciding the next step.
- **Read the header.** `# 100x30 alt cursor=4,9 settled=71ms` tells you geometry, whether it is a full-screen app, where the cursor is (0-based, same coordinates as `playnice click`), and whether the app had finished drawing.
- **Read `# attrs`.** A selected row is usually `reverse` over unchanged characters. If you ignore that block you will not see focus or selection.
- **Use `wait`, never `sleep`.** `--text`, `--regex`, `--gone`, `--idle`, `--exit`.
- **Prefer named keys.** `playnice key app C-c` beats sending `\x03`.
- **`playnice run` is for non-interactive commands.** It waits for exit; anything prompting for input blocks until the timeout.
- Sessions persist until you close them or the daemon stops. `playnice ls` shows what you left running.

From an MCP client, use `playnice mcp`; the tools mirror the commands above (see `docs/using-mcp.md`).

## Working on this repository

- Build: `npm run build` (tsc + build stamp). Test: `npm test`. Typecheck: `npm run typecheck`.
- The build stamp makes the next CLI invocation replace the running daemon and close its sessions. Use `PLAYNICE_HOME=$(mktemp -d)` to keep your own sessions out of the way.
- Tests drive a real TUI fixture (`src/test/fixtures/menu.ts`), the CLI/daemon end to end, the MCP server over stdio, and real `vim`/`less` when installed. Prefer extending the fixture over mocking.
- Docs are part of the change: `README.md` (limits), `docs/snapshot-format.md`, `docs/how-it-works.md`, `docs/using-mcp.md`, and an ADR in `docs/adr/` for user-visible tradeoffs.
- Do not add network calls or telemetry; the only socket is the local daemon socket.
