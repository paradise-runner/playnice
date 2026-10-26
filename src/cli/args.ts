/** Tiny, dependency-free option parser. Deliberately explicit about errors:
 *  an agent that mistypes a flag should get a useful message, not silence. */

export type OptionType = "string" | "number" | "boolean" | "strings";

export interface OptionSpec {
  type: OptionType;
  alias?: string;
  help?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;

export class UsageError extends Error {
  readonly exitCode = 2;
}

export interface ParsedArgs {
  options: Record<string, string | number | boolean | string[] | undefined>;
  positionals: string[];
}

function coerce(name: string, spec: OptionSpec, raw: string | boolean): string | number | boolean {
  if (spec.type === "boolean") {
    if (typeof raw === "boolean") return raw;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(`--${name} is a flag; it does not take a value`);
  }
  if (typeof raw === "boolean") throw new UsageError(`--${name} needs a value`);
  if (spec.type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new UsageError(`--${name} must be a number (got "${raw}")`);
    return value;
  }
  return raw;
}

export function parseArgs(argv: string[], specs: OptionSpecs): ParsedArgs {
  const byName = new Map<string, { name: string; spec: OptionSpec }>();
  for (const [name, spec] of Object.entries(specs)) {
    byName.set(name, { name, spec });
    if (spec.alias) byName.set(spec.alias, { name, spec });
  }

  const options: ParsedArgs["options"] = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);

      let entry = byName.get(rawName);
      let negated = false;
      if (!entry && rawName.startsWith("no-")) {
        const negatedName = rawName.slice(3);
        const found = byName.get(negatedName);
        if (found && found.spec.type === "boolean") {
          entry = found;
          negated = true;
        }
      }
      if (!entry) throw new UsageError(`Unknown option --${rawName}`);
      const { name, spec } = entry;

      if (spec.type === "boolean") {
        if (negated) options[name] = false;
        else options[name] = inline === undefined ? true : coerce(name, spec, inline);
        continue;
      }
      if (negated) throw new UsageError(`--no-${name} does not make sense for a valued option`);
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) throw new UsageError(`--${name} needs a value`);
        value = next;
        i++;
      }
      if (spec.type === "strings") {
        const list = (options[name] as string[] | undefined) ?? [];
        list.push(value);
        options[name] = list;
      } else {
        options[name] = coerce(name, spec, value);
      }
      continue;
    }
    if (token.startsWith("-") && token.length > 1 && token !== "-") {
      // Short flags; grouped booleans are allowed ("-fh"), valued flags are not.
      const chars = token.slice(1);
      let consumedValue = false;
      for (let c = 0; c < chars.length; c++) {
        const entry = byName.get(chars[c]);
        if (!entry) throw new UsageError(`Unknown option -${chars[c]}`);
        const { name, spec } = entry;
        if (spec.type === "boolean") {
          options[name] = true;
          continue;
        }
        const rest = chars.slice(c + 1);
        const next = rest.length ? rest : argv[++i];
        if (next === undefined) throw new UsageError(`-${chars[c]} needs a value`);
        if (spec.type === "strings") {
          const list = (options[name] as string[] | undefined) ?? [];
          list.push(next);
          options[name] = list;
        } else {
          options[name] = coerce(name, spec, next);
        }
        consumedValue = true;
        break;
      }
      if (consumedValue) continue;
      continue;
    }
    positionals.push(token);
  }

  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === "strings" && options[name] === undefined) options[name] = [];
  }
  return { options, positionals };
}

export function str(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new UsageError(`${name} must be a string`);
  return value;
}

export function num(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new UsageError(`${name} must be a number`);
  return value;
}

export function bool(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new UsageError(`${name} must be a boolean`);
  return value;
}

export function list(value: unknown): string[] {
  return Array.isArray(value) ? value : [];
}
