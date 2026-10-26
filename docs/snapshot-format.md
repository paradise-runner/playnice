# Screenshot format (v0.1)

A playnice screenshot is plain text with `#` comment lines around it. It is designed to be read by a model in one pass: cheap, unambiguous about geometry, and honest about whether the screen was finished when it was captured.

```
# 62x10 alt cursor=hidden settled=126ms
╭─ playnice demo ─────────────────────────────╮
│ Files                                       │
│ Search                                      │
│ Settings                                    │
│ Quit                                        │
╰──────────────────────────────────────────────╯
ready
# attrs
0:0-46 bold fg=6
1:1-45 reverse
6:0-4 dim
```

## Header

`# <cols>x<rows> <main|alt> cursor=<x>,<y>|<hidden> settled=<ms>|false [quiet=<ms>] [title="..."] [exit=<code>] [scrollback=<n>]`

| Field | Meaning |
| --- | --- |
| `cols x rows` | Geometry of the emulated screen, columns first. |
| `main` / `alt` | `alt` means the app switched to the alternate screen buffer — a full-screen TUI. `main` means normal scrolling output, typically a shell or a CLI. |
| `cursor=x,y` | 0-based cursor cell. `cursor=hidden` when the app disabled the cursor (DECTCEM). |
| `settled=<ms>` | No output and no input for that many ms when the screenshot was taken. |
| `settled=false quiet=<ms>` | Still drawing; the frame may be mid-update. `quiet` is how long the app has actually been silent. |
| `title="..."` | Window title if the app set one (OSC 0/2). |
| `exit=<code>` | Present once the process exited. |
| `scrollback=<n>` | Present when `--scrollback N` added lines above the viewport. |

Blank rows at the bottom are trimmed. `--full` keeps them. Rows are right-trimmed of spaces that cannot be seen: a space is content when it carries a background, reverse video, or a decoration, and plain padding when it only has a foreground colour (editors colour their end-of-buffer rows, and those spaces are invisible).

## Screen body

One line per cell row, in screen order. Wide characters occupy two columns and appear once. Tabs are already expanded by the emulator; there is no control-character soup.

When `--scrollback N` is used, the scrollback lines come first, followed by a `# --- viewport ---` marker and then the visible screen.

## `# attrs`

Visual state that characters cannot express: which row is selected, which label is dimmed, which panel has a background. Each line is:

```
<rows>:<cols> <token> [<token>...]
```

- `<rows>` is `3` or `3-5` (inclusive, 0-based).
- `<cols>` is `12` or `12-40` (inclusive, 0-based, in cells).
- Tokens are `bold`, `dim`, `italic`, `underline`, `blink`, `reverse`, `conceal`, `strike`, `overline`, `fg=<colour>`, `bg=<colour>`.

Colours are ANSI palette indices (`fg=2`, `fg=196`) or lowercase truecolor (`fg=#ff8800`). Rows with the same span and style are merged, so a bordered panel produces one line per border column instead of one per row. More than 60 spans are truncated with `# ... N more`.

`reverse` is reported as the attribute the app set, not as resolved colours: a reverse-video row is the standard way a TUI draws "this one is selected".

Disable with `--no-attrs` (or `attrs: false` in JSON/API calls) when you only want the characters.

## Machine form

`playnice snap --json` returns:

```json
{
  "session": "demo",
  "cols": 62,
  "rows": 10,
  "altScreen": true,
  "cursor": { "x": 10, "y": 6, "visible": false },
  "title": null,
  "settled": true,
  "quietMs": 126,
  "exited": false,
  "exitCode": null,
  "signal": null,
  "revision": 3,
  "hash": "1zXQ0m9Yw2Jc4pQ=",
  "scrollback": [],
  "lines": ["╭─ playnice demo ───╮", "│ Files            │", "..."],
  "styles": [
    { "row": 0, "col": 0, "width": 47, "style": { "bold": true, "fg": "6" } },
    { "row": 2, "col": 1, "width": 45, "style": { "reverse": true } }
  ],
  "text": "# 62x10 alt ...\n..."
}
```

`hash` covers the visible characters and styles but **not** the cursor position, so a blinking cursor never looks like activity. `revision` increments whenever that hash changes, which is the cheapest way to answer "did my keypress do anything". Every action result also carries `changed` for the same question.

## Stable facts

- The header is always one line, always first, always starts with `# `.
- The body always starts at screen row 0, so `y` in a click is just the body line index.
- `# attrs` and `# --- viewport ---` are the only other `#` lines; screen content that legitimately begins with `#` is still body text (only these exact prefixes are structural).

## Known gaps

- A right-aligned value at the end of a line loses its padding when the padding is unstyled.
- Blink is an attribute, not a timing; shade characters are geometry in PNG but just characters in text.
- Concealed text stays in the body (flagged `conceal`), because the app still wrote it.
- Inline images are not represented at all.
