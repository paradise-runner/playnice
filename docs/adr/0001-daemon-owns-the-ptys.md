# 0001 — A daemon owns the ptys

A pty is bound to the process that opened it, and an agent drives a terminal over many separate tool calls. Keeping the pty in the CLI process would mean either one long-lived shell per agent (which cannot survive a restart and cannot be shared with an MCP server) or a re-attach protocol that does not exist. So a background daemon owns every pty and every emulated screen, and both the CLI and the MCP server are thin clients over a Unix socket.

The alternative — a library-only design where the caller keeps the session in its own process — was rejected because it cannot satisfy "start this TUI now, screenshot it in the next tool call".

## Consequences

- Sessions survive client exits and are shared between the CLI and MCP, which is the point.
- There is always a background process to reason about: socket path, pid file, log, idle shutdown, and stale daemons to reap. `node-pty` child processes are the daemon's, not the caller's.
- Client and daemon must agree on the protocol. The build stamp in `VERSION` forces a mismatch to replace the daemon, which terminates its sessions.
- The socket is a local trust boundary only: mode 0600, no authentication, one user per daemon.
- Testing needs a temp `PLAYNICE_HOME` and real process lifecycle assertions, not mocks.
