# 0003 — Actions settle on quiet, and a timeout is data

Every action (`send`, `key`, `click`, `paste`, `resize`) returns after the terminal has been quiet for a short period (75ms, 200ms on `open`), so callers never sleep and re-screenshot by hand. Quiet means no output **and** no input we just sent: measuring silence from output alone would return a snapshot one instruction after a keystroke, before the app reacted, which is the classic source of flaky TUI automation.

The alternative — throwing on timeout, as Playwright does for actionability — was rejected for terminal apps. A spinner, a clock or a log tail never goes quiet, yet the frame is still worth showing; an agent can decide, where an exception would only abort the step.

## Consequences

- Actions cost at least ~75ms each; a session that is busy for long stretches must use `wait --text/--regex/--idle` rather than repeated snapshots.
- Results carry `settled` and `changed` alongside the screenshot, so the caller can distinguish "nothing happened" from "still happening".
- `open` additionally waits for the first output byte before settling, because a slow starter is silent for a while and would otherwise be screenshotted blank.
- The cursor is excluded from the screen hash so a blinking cursor is not mistaken for activity.
- Settling is a heuristic, not a protocol signal. A frame can still be captured mid-draw when an app pauses between writes; the header says so (`settled=false quiet=…ms`).
