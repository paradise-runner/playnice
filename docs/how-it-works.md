# How playnice works

Three layers, one core.

```
playnice <cmd>          playnice mcp              your TypeScript
      │                      │                         │
      └──── DaemonClient ────┘                         │
                  │                                   │
        Unix socket, newline-delimited JSON           │
                  │                                   │
             ┌────▼─────┐                             │
             │  Daemon  │                             │
             │ Registry │                             │
             └────┬─────┘                             │
                  │                                   │
        ┌─────────▼──────────┐                        │
        │ Session            │◄───────────────────────┘
        │  node-pty  ⇄ pty   │
        │  @xterm/headless   │  (screen emulation)
        └─────────┬──────────┘
                  │
        snapshot · PNG · wait
```

## Why a daemon

A pty belongs to the process that opened it. If `playnice open` exited, the terminal would die with it, and an agent would have to keep one long-lived shell to poke at a TUI. The daemon holds the pty, so:

- a session survives across CLI invocations and tool calls;
- the CLI and the MCP server see the same sessions (start a TUI from bash, screenshot it from an agent);
- closing your editor or agent does not kill a long-running TUI you were testing.

Costs: a background process, a state directory, and version skew between client and daemon. The build stamp in `VERSION` handles skew — a client that meets a daemon from another build replaces it, which closes its sessions.

State lives in `~/.playnice` (override with `PLAYNICE_HOME`):

| File | Purpose |
| --- | --- |
| `daemon.sock` | Unix socket, mode 0600. The only interface. |
| `daemon.json` | pid, version, protocol, start time. Used to reap stale daemons. |
| `daemon.pid` | pid, for `daemon status` and reaping. |
| `daemon.log` | Timestamped daemon events and RPC errors. |
| `screenshots/` | Default output of `playnice shot`. |

The daemon exits after 12 hours with no sessions and no connected clients (`--idle-ms` to change), or immediately on `playnice daemon stop`. Both paths terminate children and remove the socket.

## A session

`Session` spawns the child with `node-pty` at the requested size, with:

- `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=playnice`, `PLAYNICE=1`;
- the daemon's environment, plus anything from `--env`;
- `--cwd`, defaulting to the daemon's working directory.

Output bytes go into `@xterm/headless`, which runs the same parser as xterm.js in a browser. That buys correct handling of scrolling regions, alternate screen, wide characters, mouse modes, bracketed paste and synchronized output without writing a VT emulator.

Writes from the pty are asynchronous, so every read first waits for the parser queue to drain (`flush`). If output ever piles up (a runaway `cat`), the pty is paused above 4000 queued writes and resumed below 500, so a session cannot eat memory.

`open` waits for the first output byte (up to 2.5s) before settling. Without that, a slow starter — `docker run`, `node app.js`, `ssh` — would be screenshotted while still blank.

## Settling

An action (`send`, `key`, `click`, `paste`, `resize`, …) does three things:

1. record the screen hash;
2. write the bytes;
3. wait until nothing has happened for `quietMs` (default 75), then screenshot.

"Nothing has happened" counts **both** output and the input we just sent. That detail matters: measuring silence from the last output alone would declare the screen settled one instruction after a keypress, before the app had reacted, which is how this class of tool produces flaky results.

A bare `Escape` is special. The byte is ambiguous — an app cannot tell "Escape" from the start of an escape sequence — so editors such as vim wait for a timeout before redrawing (measured between 38ms and 180ms here, and longer under load). When an action's input ends with `ESC`, playnice waits up to 350ms for the app to react before it starts counting quiet; without that, leaving insert mode would screenshot the stale screen. Verified by the `vim` test, which asserts `-- INSERT --` is gone in the same screenshot as the Escape.

If the app never goes quiet (a spinner, a clock, a log tail), the action gives up at `timeoutMs` (default 1500) and returns the current frame with `settled=false`. A timeout is data, not an exception: `wait` and actions report what is on screen and let the caller decide.

For anything slower than an instant repaint, poll for a condition instead:

```sh
playnice wait --text "Build complete" --timeout 120000
playnice wait --regex 'ready on port \d+' --idle 500
playnice wait --exit
```

The cursor is deliberately excluded from the screen hash, so a blinking cursor does not look like activity. Cursor *visibility* changes are tracked by scanning the byte stream for DECSET/DECRST 25, because xterm does not expose DECTCEM.

## Input

| Kind | Encoding |
| --- | --- |
| Text | Written as-is (`\r\n` normalised to `\r`), or wrapped in `ESC[200~ … ESC[201~` when the app enabled bracketed paste and the text contains newlines, tabs or ESC. |
| Named keys | `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Insert`, `Home`, `End`, `PageUp`, `PageDown`, `Up`/`Down`/`Left`/`Right`, `F1`–`F12`, `Space`, or a single character. Arrows and Home/End switch to SS3 when the app enabled application cursor keys (DECCKM). |
| Chords | `C-c`, `Ctrl+c`, `ctrl-c`, `Alt+x`, `M-x`, `Shift+Tab`, `C-S-a`, `Ctrl+Up` (`ESC[1;5A`). Both `+` and `-` separate modifiers. |
| Mouse | SGR 1006: `ESC[<b;x;yM` press, `…m` release, wheel `64`/`65`, drag with the motion bit, plus shift/alt/ctrl bits. Coordinates convert from 0-based cells to 1-based wire values. |

Drags interpolate intermediate motion events (one per ~2 cells) because most TUIs only update selection on motion.

## PNG rendering

`playnice shot` rasterizes the cell grid with `@napi-rs/canvas`:

- background rectangles first, then glyphs;
- bold/italic via the font, dim via alpha, reverse by swapping foreground and background, underline/strike as lines, conceal skipped;
- the 256-colour palette expanded to RGB; truecolor passed through;
- the configured monospace font with CJK/emoji fallbacks in the family list, so one missing glyph does not become an empty box;
- box-drawing, block and shade characters drawn as geometry (lines, rectangles, arcs) instead of glyphs — fonts size these for their own line box, which leaves visible gaps at terminal cell heights;
- the cursor as a filled block with the underlying character repainted in the background colour.

The canvas module is imported lazily: the daemon pays for a native rasterizer only when someone asks for a PNG.

## MCP

`playnice mcp` speaks MCP over stdio and forwards every tool call to the same daemon, so an MCP-driven session is visible to `playnice ls`. Tool results are the text screenshot plus a one-line `# action changed=… settled=…` status for actions, and `terminal_screenshot` returns an `image/png` content part.

## Library

The core is exported from the package root, so a test runner can be built on it without the daemon:

```ts
import { Session, renderPng } from "playnice";

const session = await Session.open({ id: "app", command: "npm", args: ["run", "tui"], cols: 100, rows: 30 });
const action = await session.press(["Down", "Enter"]);
if (!action.snapshot.lines.some((line) => line.includes("Saved"))) throw new Error("not saved");
await session.close();
```

`Session` exposes `send`, `type`, `paste`, `press`, `click`, `drag`, `wheel`, `resize`, `snapshot`, `screenshot`, `settle`, `wait`, `close` and `summary`. `Screen` can also replay a recorded byte stream if you have one.

## Deliberate gaps

The emulator is xterm's, so playnice inherits both its coverage and its limits: no inline image protocols, no clipboard reads, no kitty keyboard protocol. Settling is a quiet-period heuristic, not a protocol-level "frame rendered" signal. Mouse support is SGR 1006 only. The full list, with workarounds, is in the README's [Limits](../README.md#limits-v01) section.
