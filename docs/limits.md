# Limits (v0.1)

Everything playnice does not do, and what to reach for instead.

## Scope

It drives terminals; it is not a test framework. No assertion DSL, no runner integration, no trace viewer, no video recording. The library exports what a runner would need (`Session`, snapshot helpers), but you write the assertions.

## Linux output tail

When a child writes a large burst of output and exits immediately, `node-pty`'s read stream on Linux can report end-of-file before every byte has been read, so the last lines of that burst can be missing. It is a race in the pty read path, not in the emulator: the same burst lost its tail in 3–4 of 6 runs in a container, and macOS is unaffected. Long-running and streaming commands do not trigger it, because the child stays alive while its output is read — `vim`, pagers and shells are fine in practice.

The fix is to own the read side (duplicate the master fd and drain it after EOF), which is a 0.2.0 change. The burst test is skipped on Linux; the investigation is in [#1](https://github.com/paradise-runner/playnice/issues/1). Workaround: `wait --text <marker>` on text printed before the burst.

## Terminal emulation

The screen comes from `@xterm/headless`, so playnice sees what xterm.js sees.

- Inline images (sixel, kitty, iTerm2) are not captured. Text screenshots show nothing where an app paints one; PNGs leave that area blank.
- OSC 52 clipboard writes are not readable; OSC 8 hyperlinks are not exposed.
- Blink is reported as an attribute, not as timing. Concealed text stays in the body, flagged `conceal`.
- Unicode width follows xterm's tables.

## Screenshots are lossy on purpose

- Trailing blank rows are trimmed (`--full` keeps them).
- Trailing spaces are trimmed unless visible (background, reverse, underline, strike, overline). A foreground-coloured space is padding; a background-coloured one is content.
- Spans that share a style and column range merge vertically, so a border column is one line rather than one per row.
- `# attrs` names style spans, not individual cells, and truncates after 60 spans with `# ... N more`.

## Settling is a heuristic

"Settled" means no output *and* no input for 75ms (200ms on `open`; up to 350ms after a bare `Escape`, because apps wait out the ambiguity before redrawing).

- An app that animates forever — a clock, a spinner, a log tail — never settles: the action returns after `--timeout` (1500ms by default) with `settled=false` and whatever frame is current.
- A program that is silent before it paints is handled at `open`, which waits up to 2.5s for the first byte. After that, use `wait --text`, `--regex`, `--idle` or `--exit`.
- An app slower than ~75ms per repaint can still be screenshotted mid-thought. The header says `settled=false` when playnice knows; `wait` is the reliable answer when it does not.

## Input

- Mouse is SGR 1006 only. An app that negotiates only X10 or urxvt encodings will ignore clicks.
- Keys cover letters, digits, arrows, Home/End/PageUp/PageDown, Delete/Insert, F1–F12 and Shift/Alt/Ctrl chords. Media keys and the kitty keyboard protocol are not supported.
- Text is written in one chunk with no input-side flow control; there is no IME support.

## Daemon and storage

- Sessions live in a background daemon behind `~/.playnice/daemon.sock` (mode 0600). There is no authentication: any process running as your user can drive your terminals.
- `daemon.json`, `daemon.pid` and `daemon.log` sit beside the socket.
- Sessions die with the daemon: `playnice daemon stop`, or 12 hours after the last session and client disappear.
- A CLI and daemon from different builds cannot talk. The mismatch closes all sessions and starts a fresh daemon.
- Nothing survives a reboot; there is no session history to replay. Scrollback is 2000 lines per session.
- PNGs written by `shot` default to `~/.playnice/screenshots/` and are never deleted by playnice.

## Platform

- macOS is developed and tested locally. Linux runs the same suite on Ubuntu in CI (Node 20, 22, 24) with the tail exception above.
- Windows paths exist (named pipe instead of a socket, `node-pty` prebuilds) and are untested.
- PNG text uses the first available monospace font with CJK/emoji fallbacks. Ligatures and colour emoji depend on what the system provides. Box-drawing and block characters are drawn geometrically, not taken from the font.

## Network

No network requests, no telemetry. The only socket is the local Unix socket above. Verify with `rg -n "fetch|https?://" src`.
