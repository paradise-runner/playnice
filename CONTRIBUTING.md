# Contributing

## Setup

```sh
npm install
npm run build
npm test
```

Node 20+. If `npm install` could not run `node-pty`'s install script, mark its helper executable:

```sh
chmod +x node_modules/node-pty/prebuilds/*/spawn-helper
```

## Layout

| Path | Contains |
| --- | --- |
| `src/core/` | `Session` (pty + action queue + waits), `Screen` (xterm headless), snapshot rendering, PNG renderer, key and mouse encoders |
| `src/daemon/` | Unix-socket server, typed client, wire protocol, process entry point |
| `src/cli/` | Arg parsing, commands, output formatting |
| `src/mcp/` | MCP tool definitions over the daemon client |
| `src/test/` | `node:test` suites and the TUI fixtures they drive |
| `docs/` | Screenshot format, architecture, MCP setup, ADRs |

## Development loop

```sh
npm run build      # tsc + build stamp in dist/build.json
npm run typecheck  # no emit
npm test           # builds, then node --test "dist/test/**/*.test.js"
node bin/playnice.js --help
```

Rebuilding changes the build stamp, so the next command replaces the running daemon and its sessions. That is intentional: a daemon serving stale code is worse than a lost session. Use `PLAYNICE_HOME=$(mktemp -d)` for throwaway sessions.

Run one suite while iterating:

```sh
node --test dist/test/session.test.js
```

Tests that need real programs (`vim`, `less`) skip themselves when the binary is missing.

## Tests before you write a feature

`src/test/fixtures/menu.ts` is a real TUI: alternate screen, reverse-video selection, SGR mouse, bracketed paste, SIGWINCH reflow, clean exit. Extend it when you add a capability, rather than mocking a terminal. If a behaviour only exists in a unit test, it is probably not wired up.

## Documentation

| File | Owns |
| --- | --- |
| `README.md` | What it is, install, first run, task table, limits, architecture summary |
| `docs/snapshot-format.md` | The screenshot grammar and every deliberate loss |
| `docs/how-it-works.md` | Daemon lifecycle, session internals, settling, input encoding, PNG rendering |
| `docs/using-mcp.md` | Agent-facing setup and the loop that works |
| `docs/adr/` | One decision per file, with consequences |
| `AGENTS.md` | Short instructions for an agent using playnice as a tool |

## Pull request checklist

- Tests cover the behaviour, ideally against the fixture TUI or a real program.
- `npm run typecheck` and `npm test` pass.
- Behaviour changes update the matching doc above.
- The README **Limits** section is re-read whenever a command, surface, platform or dependency changes.
- A new user-visible tradeoff gets an ADR and a line under **Decisions** in the README.
- Links and anchors resolve: `node scripts/check-doc-links.mjs .` (dependency-free checker).

## Style

- Describe behaviour, not quality: "returns the settled screen", not "blazing fast".
- Errors tell the user what to do next (`No session "t1". Open sessions: t2`).
- Keep the screenshot format stable; add fields rather than reinterpreting existing ones.
- No network calls. If a change would add one, it needs an ADR.
