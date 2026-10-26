/**
 * Key encoding: turn human names ("C-c", "Down", "Shift+Tab", "\\x1b[A") into
 * the bytes a terminal application actually receives.
 */

export interface KeyModes {
  /** DECCKM — arrows/Home/End switch to SS3 (`ESC O A`). */
  applicationCursorKeys?: boolean;
}

export interface ParsedKey {
  /** Byte sequence to write to the pty. */
  sequence: string;
  /** Normalized name, for error messages and logs. */
  name: string;
}

interface KeyDef {
  normal: string;
  app?: string;
  /** CSI/SS3 final byte for modifier-encoded variants, when supported. */
  csi?: { prefix: string; final: string };
}

const KEYS: Record<string, KeyDef> = {
  enter: { normal: "\r" },
  return: { normal: "\r" },
  cr: { normal: "\r" },
  tab: { normal: "\t" },
  "shift+tab": { normal: "\x1b[Z" },
  backtab: { normal: "\x1b[Z" },
  escape: { normal: "\x1b" },
  esc: { normal: "\x1b" },
  backspace: { normal: "\x7f" },
  bs: { normal: "\x7f" },
  space: { normal: " " },
  delete: { normal: "\x1b[3~", csi: { prefix: "3", final: "~" } },
  del: { normal: "\x1b[3~", csi: { prefix: "3", final: "~" } },
  insert: { normal: "\x1b[2~", csi: { prefix: "2", final: "~" } },
  ins: { normal: "\x1b[2~", csi: { prefix: "2", final: "~" } },
  home: { normal: "\x1b[H", app: "\x1bOH", csi: { prefix: "1", final: "H" } },
  end: { normal: "\x1b[F", app: "\x1bOF", csi: { prefix: "1", final: "F" } },
  pageup: { normal: "\x1b[5~", csi: { prefix: "5", final: "~" } },
  pagedown: { normal: "\x1b[6~", csi: { prefix: "6", final: "~" } },
  pgup: { normal: "\x1b[5~", csi: { prefix: "5", final: "~" } },
  pgdn: { normal: "\x1b[6~", csi: { prefix: "6", final: "~" } },
  up: { normal: "\x1b[A", app: "\x1bOA", csi: { prefix: "1", final: "A" } },
  down: { normal: "\x1b[B", app: "\x1bOB", csi: { prefix: "1", final: "B" } },
  right: { normal: "\x1b[C", app: "\x1bOC", csi: { prefix: "1", final: "C" } },
  left: { normal: "\x1b[D", app: "\x1bOD", csi: { prefix: "1", final: "D" } },
  f1: { normal: "\x1bOP", csi: { prefix: "1", final: "P" } },
  f2: { normal: "\x1bOQ", csi: { prefix: "1", final: "Q" } },
  f3: { normal: "\x1bOR", csi: { prefix: "1", final: "R" } },
  f4: { normal: "\x1bOS", csi: { prefix: "1", final: "S" } },
  f5: { normal: "\x1b[15~", csi: { prefix: "15", final: "~" } },
  f6: { normal: "\x1b[17~", csi: { prefix: "17", final: "~" } },
  f7: { normal: "\x1b[18~", csi: { prefix: "18", final: "~" } },
  f8: { normal: "\x1b[19~", csi: { prefix: "19", final: "~" } },
  f9: { normal: "\x1b[20~", csi: { prefix: "20", final: "~" } },
  f10: { normal: "\x1b[21~", csi: { prefix: "21", final: "~" } },
  f11: { normal: "\x1b[23~", csi: { prefix: "23", final: "~" } },
  f12: { normal: "\x1b[24~", csi: { prefix: "24", final: "~" } },
};

const ALIASES: Record<string, string> = {
  return: "enter",
  cr: "enter",
  esc: "escape",
  bs: "backspace",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  backtab: "shift+tab",
  spc: "space",
};

const MOD_ALIASES: Record<string, "shift" | "alt" | "ctrl"> = {
  shift: "shift",
  s: "shift",
  alt: "alt",
  opt: "alt",
  option: "alt",
  meta: "alt",
  m: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  c: "ctrl",
};

function normalizeName(raw: string): string {
  const lower = raw.toLowerCase();
  // "arrow up", "arrowup", "page up" → canonical single token
  const squashed = lower.replace(/[\s_-]+/g, "");
  if (KEYS[squashed]) return squashed;
  if (ALIASES[squashed]) return ALIASES[squashed];
  // "arrow up" → "arrowup" → "up"
  const withoutArrow = squashed.replace(/^arrow/, "");
  if (KEYS[withoutArrow]) return withoutArrow;
  return squashed;
}

/** Decode C-style escapes so `--key '\\e[A'` works like a terminal user expects. */
export function unescape(raw: string): string {
  return raw.replace(
    /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[abefnrtv\\'"])/g,
    (_m, seq: string) => {
      if (seq[0] === "x") return String.fromCharCode(parseInt(seq.slice(1), 16));
      if (seq[0] === "u") return String.fromCharCode(parseInt(seq.slice(1), 16));
      switch (seq) {
        case "a":
          return "\x07";
        case "b":
          return "\b";
        case "e":
          return "\x1b";
        case "f":
          return "\f";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "v":
          return "\x0b";
        case "\\":
          return "\\";
        case "'":
          return "'";
        case '"':
          return '"';
        default:
          return seq;
      }
    },
  );
}

/**
 * Parse a single key spec into the bytes to send.
 *
 * Supported forms: `Enter`, `Up`, `F5`, `Escape`, `Ctrl+c`, `C-c`, `Alt+x`,
 * `Shift+Tab`, `Ctrl+Up`, a bare printable char (`a`, `/`, `?`), or a raw
 * escape string (`\x1b[A`, `\e`).
 */
const MODIFIER_PREFIX = /^(ctrl|control|alt|opt|option|meta|shift|s|m|c)[+-]/i;

/**
 * Split "C-S-a", "Ctrl+Shift+a", "Alt-x" or "m-x" into modifiers + base key.
 * Both `+` and `-` are accepted as separators so terminal habits ("C-c") and
 * Playwright habits ("Control+c") both work.
 */
function tokenize(raw: string): { mods: Set<"shift" | "alt" | "ctrl">; base: string } {
  const mods = new Set<"shift" | "alt" | "ctrl">();
  let rest = raw;
  for (;;) {
    const match = MODIFIER_PREFIX.exec(rest);
    if (!match) break;
    const mod = MOD_ALIASES[match[1].toLowerCase()];
    // A bare "c" is the letter c, not a modifier; the regex requires a separator.
    if (!mod) break;
    mods.add(mod);
    rest = rest.slice(match[0].length);
  }
  return { mods, base: rest };
}

export function parseKey(spec: string, modes: KeyModes = {}): ParsedKey {
  const raw = spec.trim();
  if (raw === "") return { sequence: "", name: "" };

  // Raw escapes pass through untouched.
  if (raw.includes("\\")) {
    return { sequence: unescape(raw), name: raw };
  }

  const { mods, base } = tokenize(raw);
  const canonical = normalizeName(base);

  if (canonical === "shift+tab" || (canonical === "tab" && mods.has("shift"))) {
    return { sequence: "\x1b[Z", name: "Shift+Tab" };
  }

  const def = KEYS[canonical];
  const anyMod = mods.size > 0;

  if (def) {
    if (!anyMod) {
      return {
        sequence: def.app && modes.applicationCursorKeys ? def.app : def.normal,
        name: canonical,
      };
    }
    // Modifier-encoded CSI: ESC [ <prefix> ; <1+shift+alt*2+ctrl*4> <final>
    if (def.csi) {
      const mod = 1 + (mods.has("shift") ? 1 : 0) + (mods.has("alt") ? 2 : 0) + (mods.has("ctrl") ? 4 : 0);
      return { sequence: `\x1b[${def.csi.prefix};${mod}${def.csi.final}`, name: spec };
    }
    // Keys with no modifier form (Enter, Tab, Escape...): ESC prefix for alt.
    return { sequence: (mods.has("alt") ? "\x1b" : "") + def.normal, name: spec };
  }

  if (base.length === 1) {
    const ch = base;
    if (mods.has("ctrl")) {
      const lower = ch.toLowerCase();
      const code = lower.charCodeAt(0);
      let out: string;
      if (lower === " ") out = "\x00";
      else if (code >= 97 && code <= 122) out = String.fromCharCode(code - 96);
      else if (ch === "[" || ch === "{") out = "\x1b";
      else if (ch === "\\" || ch === "|") out = "\x1c";
      else if (ch === "]" || ch === "}") out = "\x1d";
      else if (ch === "^" || ch === "~") out = "\x1e";
      else if (ch === "_" || ch === "-") out = "\x1f";
      else if (ch === "?") out = "\x7f";
      else out = String.fromCharCode(code & 0x1f);
      return { sequence: (mods.has("alt") ? "\x1b" : "") + out, name: spec };
    }
    const shifted = mods.has("shift") ? ch.toUpperCase() : ch;
    return { sequence: (mods.has("alt") ? "\x1b" : "") + shifted, name: spec };
  }

  throw new Error(
    `Unknown key: "${spec}". Use a named key (Enter, Tab, Escape, Up, F5, Home...), a chord (C-c, Alt+x, Shift+Tab), a single character, or a raw escape like '\\x1b[A'.`,
  );
}

/** Encode a list of key specs into one byte string. */
export function encodeKeys(specs: string[], modes: KeyModes = {}): string {
  return specs.map((s) => parseKey(s, modes).sequence).join("");
}

/** Wrap text in bracketed-paste markers when the app asked for them. */
export function bracketedPaste(text: string): string {
  // Nothing inside a paste may terminate it early.
  return `\x1b[200~${text.replace(/\x1b\[201~/g, "")}\x1b[201~`;
}

/**
 * Decide how to deliver `text`: raw keystrokes, or a bracketed paste when the
 * app enabled it and the text would otherwise be interpreted as control input
 * (embedded newlines, tabs, escape characters).
 */
export function encodeText(text: string, modes: KeyModes & { bracketedPaste?: boolean } = {}): string {
  if (!text) return "";
  const needsProtection = /[\r\n\t\x1b]/.test(text);
  if (modes.bracketedPaste && needsProtection) return bracketedPaste(text);
  return text.replace(/\r\n/g, "\r");
}
