import type { MouseButton, MouseModifiers } from "./types.js";

/**
 * SGR mouse encoding (DECSET 1006): `ESC [ < b ; x ; y M` for press/motion and
 * `... m` for release. Coordinates are 1-based on the wire.
 *
 * Almost every modern TUI (fzf, lazygit, btop, helix, vim `ttymouse=sgr`)
 * negotiates 1006, which is the only mode playnice emits. The older X10 and
 * urxvt encodings are ambiguous above column/row 95 and cannot express releases.
 */
const BUTTON_CODE: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

function modifierBits(mods: MouseModifiers = {}): number {
  return (mods.shift ? 4 : 0) + (mods.alt ? 8 : 0) + (mods.ctrl ? 16 : 0);
}

function seq(code: number, x: number, y: number, final: "M" | "m"): string {
  return `\x1b[<${code};${x + 1};${y + 1}${final}`;
}

export function mouseDown(
  x: number,
  y: number,
  button: MouseButton = "left",
  mods: MouseModifiers = {},
): string {
  return seq(BUTTON_CODE[button] + modifierBits(mods), x, y, "M");
}

export function mouseUp(
  x: number,
  y: number,
  button: MouseButton = "left",
  mods: MouseModifiers = {},
): string {
  return seq(BUTTON_CODE[button] + modifierBits(mods), x, y, "m");
}

/** Motion. With no button held this is a "hover" (needs mode 1003). */
export function mouseMove(
  x: number,
  y: number,
  button: MouseButton | null = null,
  mods: MouseModifiers = {},
): string {
  const code = (button === null ? 35 : 32 + BUTTON_CODE[button]) + modifierBits(mods);
  return seq(code, x, y, "M");
}

export function mouseWheel(
  x: number,
  y: number,
  direction: "up" | "down",
  mods: MouseModifiers = {},
): string {
  const code = (direction === "up" ? WHEEL_UP : WHEEL_DOWN) + modifierBits(mods);
  return seq(code, x, y, "M");
}

export function mouseClick(
  x: number,
  y: number,
  button: MouseButton = "left",
  mods: MouseModifiers = {},
  double = false,
): string {
  const press = mouseDown(x, y, button, mods);
  const release = mouseUp(x, y, button, mods);
  return double ? press + release + press + release : press + release;
}
