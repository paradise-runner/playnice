# Driving playnice from an agent (MCP)

`playnice mcp` runs an MCP server on stdio. Every tool call goes to the same daemon the CLI talks to, so a terminal opened from bash is visible to the agent and vice versa.

## Configure

Any client that can spawn a command works. Use the absolute path to the built CLI.

```json
{
  "mcpServers": {
    "playnice": {
      "command": "node",
      "args": ["/absolute/path/to/playnice/bin/playnice.js", "mcp"]
    }
  }
}
```

If `playnice` is on your `PATH` (`npm link`), the shorter form is enough:

```json
{ "mcpServers": { "playnice": { "command": "playnice", "args": ["mcp"] } } }
```

Set `PLAYNICE_HOME` in the server's environment to isolate sessions (a per-project directory is a reasonable choice).

## Tools

| Tool | What it does |
| --- | --- |
| `terminal_open` | Start a program (or `$SHELL`) in a pty. Returns the first screen. Default 100x30. |
| `terminal_send` | Type text and press Enter. Returns the settled screen. |
| `terminal_type` | Type without Enter. |
| `terminal_paste` | Deliver text as one bracketed paste. |
| `terminal_key` | Press named keys or chords, in order. |
| `terminal_click` | Click a cell (0-based). Optional button, double click, modifiers. |
| `terminal_drag` | Press, move, release between two cells. |
| `terminal_scroll` | Wheel up/down at a cell. |
| `terminal_resize` | Resize the pty and return the reflowed screen. |
| `terminal_snapshot` | Screenshot as `text` (default), `ansi`, or `json`. Optional scrollback. |
| `terminal_screenshot` | PNG image content part; optionally saved to a path. |
| `terminal_wait` | Block until text/regex appears, disappears, output is idle, or the process exits. |
| `terminal_list` | Open terminals with size, screen type, status and idle time. |
| `terminal_close` | Kill the process and return the final screen. |
| `terminal_run` | Run a command to completion, return output and exit code, then close. |

## A loop that works

1. `terminal_open` with an explicit `cols`/`rows` — TUIs reflow, and a terminal that is too small hides the behaviour you are looking at.
2. `terminal_snapshot` if you want to confirm the app is up before touching it.
3. Act once: `terminal_send`, `terminal_key`, `terminal_click`.
4. Read the screenshot in the *same* response. Do not send another action before looking; the result already tells you whether the screen changed.
5. When an action is slow (build, network, watcher), use `terminal_wait` with `text`, `regex` or `idleMs` instead of repeating snapshots.

## Reading a screenshot

```
# 100x30 alt cursor=4,9 settled=71ms
```

- `alt` means a full-screen TUI; `main` means ordinary scrolling output.
- `cursor=4,9` is a 0-based cell; the same coordinates you pass to `terminal_click`.
- `settled=false` means the app is still drawing — the frame may be mid-update. Prefer `terminal_wait` next time.
- The `# attrs` block lists highlighted spans (`reverse`, colours, `bold`). That is how you see which row is selected, which button is focused, and which panel has the background — the characters alone do not change.

Full format: [snapshot-format.md](snapshot-format.md).

## Guardrails worth keeping in an AGENTS.md

- One action per look. Screenshots are cheap; guessing is not.
- Prefer `terminal_key` with named keys over sending escape sequences by hand.
- After sending text to a menu, confirm the highlighted row moved (`# attrs` reverse span) rather than assuming the keystroke landed.
- Close terminals you opened; each one is a real process with real resources.
- `terminal_run` is for non-interactive commands. Anything that waits for input will block until the timeout and be killed.

## Debugging the server

```sh
playnice daemon log      # last 60 daemon log lines
playnice daemon status   # pid, version, session count
playnice ls              # sessions the agent created
```

If a tool call reports a version mismatch, a rebuilt CLI replaced the daemon and closed its sessions; re-open the terminal.
