# 0002 — Screenshots are text first, PNG second

An agent that iterates on a TUI needs to see the screen dozens of times per task. A PNG costs hundreds to thousands of tokens, cannot be diffed, and is ambiguous about cursor position; a text rendering of the same cells is exact, cheap, and greppable. So the default screenshot is text: a header line with geometry, cursor, screen type and settle state, the characters, and an `# attrs` block for the style spans that characters cannot express.

The alternative — image-first, like computer-use agents — was rejected for terminals specifically: everything meaningful is already in the character grid plus attributes.

## Consequences

- `# attrs` exists because "which row is selected" is usually reverse video over unchanged characters. Without it, text screenshots would silently lose the most important state in a TUI.
- Text output is lossy by construction: trailing unstyled spaces are trimmed, and blink is an attribute rather than timing. The format documents each loss; `--json` carries the full grid when exactness matters.
- PNG rendering remains available and is the right choice for colour, font coverage and pixel alignment, but it is an explicit opt-in with its own costs (a native canvas dependency, system fonts, no inline images).
- Every consumer — CLI, MCP, library — returns the same text shape, so an agent's reading strategy does not depend on which entry point it used.
