import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DaemonClient } from "../daemon/client.js";
import { snapshotToJson } from "../core/snapshot.js";
import { VERSION } from "../core/version.js";
import type { ActionResult } from "../core/session.js";
import type { SessionSummary, Snapshot } from "../core/types.js";

export interface McpOptions {
  home?: string;
}

type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

const COORDINATES = "x and y are 0-based cell coordinates from the top-left of the screen.";

function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `playnice: ${message}` }], isError: true };
}

function actionText(action: ActionResult): string {
  const status = [
    `action changed=${action.changed}`,
    action.settled ? `settled=${Math.round(action.waitedMs)}ms` : "still-drawing",
  ].join(" ");
  return `# ${status}\n${action.snapshot.text}`;
}

function summaryLine(session: SessionSummary): string {
  const cmd = [session.command, ...session.args].join(" ");
  return `${session.id} · ${session.cols}x${session.rows}${session.altScreen ? " alt" : ""} · ${
    session.exited ? `exited(${session.exitCode ?? "?"})` : "running"
  } · pid ${session.pid} · ${cmd}`;
}

/**
 * MCP server: the same primitives as the CLI, shaped for an agent that is
 * iterating on a CLI or TUI.
 */
export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  const server = new McpServer({ name: "playnice", version: VERSION });
  let connected: Promise<DaemonClient> | undefined;
  const client = (): Promise<DaemonClient> => (connected ??= DaemonClient.connect({ home: options.home }));

  const resolveId = async (id?: string): Promise<string> => {
    if (id) return id;
    const c = await client();
    const sessions = await c.call("list", {});
    if (sessions.length === 1) return sessions[0].id;
    const fallback = sessions.find((s) => s.id === "default");
    if (fallback) return fallback.id;
    if (!sessions.length) {
      throw new Error("No terminal is open yet. Call terminal_open first.");
    }
    throw new Error(
      `Several terminals are open (${sessions.map((s) => s.id).join(", ")}). Pass id explicitly.`,
    );
  };

  const idSchema = z
    .string()
    .optional()
    .describe("Terminal id. Omit when exactly one terminal is open.");

  server.registerTool(
    "terminal_open",
    {
      title: "Open a terminal",
      description: `Start a program in a new pseudo-terminal (pty) and return the first screen.

Use this once, then drive the app with terminal_send / terminal_key / terminal_click and read the result from the screenshot they return. Omit command to get an interactive shell. Sessions persist between tool calls and between CLI invocations; list them with terminal_list and dispose with terminal_close.

Set cols/rows deliberately: TUIs reflow, and a too-small terminal hides the behaviour you are testing. Defaults are 100x30.`,
      inputSchema: {
        command: z.string().optional().describe("Executable to run. Omit for $SHELL."),
        args: z.array(z.string()).optional().describe("Arguments for the command."),
        cwd: z.string().optional().describe("Working directory."),
        env: z.record(z.string(), z.string()).optional().describe("Extra environment variables."),
        cols: z.number().int().min(1).max(1000).optional().describe("Width in cells (default 100)."),
        rows: z.number().int().min(1).max(500).optional().describe("Height in cells (default 30)."),
        id: z.string().optional().describe("Explicit session id (default: t1, t2, ... or the name)."),
        name: z.string().optional().describe("Friendly name, also used as the default id."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const c = await client();
        const result = await c.call("open", params);
        return {
          content: [{ type: "text", text: `${summaryLine(result.summary)}\n\n${result.snapshot.text}` }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_send",
    {
      title: "Type text and press Enter",
      description: `Type text into the terminal and press Enter (set enter=false to skip), then wait for the app to finish drawing and return the resulting screenshot.

This is the main way to run commands and answer prompts. The screenshot shows the settled screen, so you can chain several actions without polling. If the app keeps animating, the header says settled=false: the screen is a best-effort frame, not a final state.`,
      inputSchema: {
        id: idSchema,
        text: z.string().describe("Text to type. Newlines and tabs are pasted safely when the app supports bracketed paste."),
        enter: z.boolean().optional().describe("Press Enter after typing. Default true."),
        settleMs: z.number().int().min(0).max(60_000).optional().describe("Quiet period that counts as finished (default 75ms)."),
        timeoutMs: z.number().int().min(0).max(120_000).optional().describe("Max time to wait for the screen to settle (default 1500ms)."),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("send", {
          id: await resolveId(params.id),
          text: params.text,
          enter: params.enter,
          quietMs: params.settleMs,
          timeoutMs: params.timeoutMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_type",
    {
      title: "Type text without Enter",
      description: `Type literal text without pressing Enter. Use for passwords, incremental search boxes, and anything where a newline would change the state.

For multi-line bodies prefer terminal_paste, which uses bracketed paste so the app receives the text as one edit rather than a burst of keystrokes.`,
      inputSchema: {
        id: idSchema,
        text: z.string().describe("Text to type."),
        settleMs: z.number().int().min(0).max(60_000).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("type", {
          id: await resolveId(params.id),
          text: params.text,
          quietMs: params.settleMs,
          timeoutMs: params.timeoutMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_paste",
    {
      title: "Paste a block of text",
      description: `Paste text as one chunk, using bracketed paste when the app enabled it (mode 2004). Ideal for code, multi-line prompts and anything containing newlines that should not submit.`,
      inputSchema: {
        id: idSchema,
        text: z.string().describe("Text to paste."),
        settleMs: z.number().int().min(0).max(60_000).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("paste", {
          id: await resolveId(params.id),
          text: params.text,
          quietMs: params.settleMs,
          timeoutMs: params.timeoutMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_key",
    {
      title: "Press keys",
      description: `Press one or more keys, in order. Each entry is one key: "Enter", "Tab", "Escape", "Backspace", "Delete", "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown", "F1".."F12", "Space", or a chord like "C-c" (Ctrl+C), "Alt+x", "Shift+Tab", "Ctrl+Up". A raw escape such as "\\x1b[A" is sent verbatim.

Use this instead of terminal_send when nothing should be submitted — menus, pagers, vim, tmux, dialogs. Returns the settled screenshot.`,
      inputSchema: {
        id: idSchema,
        keys: z.array(z.string()).min(1).describe('Keys to press in order, e.g. ["Down","Down","Enter"].'),
        settleMs: z.number().int().min(0).max(60_000).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("press", {
          id: await resolveId(params.id),
          keys: params.keys,
          quietMs: params.settleMs,
          timeoutMs: params.timeoutMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_click",
    {
      title: "Click a cell",
      description: `Click at a cell. ${COORDINATES} Most full-screen TUIs enable SGR mouse reporting; if the app ignores the click, it does not handle the mouse at all.

Returns the settled screenshot.`,
      inputSchema: {
        id: idSchema,
        x: z.number().int().min(0).describe("Column, 0-based."),
        y: z.number().int().min(0).describe("Row, 0-based."),
        button: z.enum(["left", "middle", "right"]).optional().describe("Default left."),
        double: z.boolean().optional().describe("Double click."),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        ctrl: z.boolean().optional(),
        settleMs: z.number().int().min(0).max(60_000).optional(),
        timeoutMs: z.number().int().min(0).max(120_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("click", {
          ...params,
          id: await resolveId(params.id),
          quietMs: params.settleMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_drag",
    {
      title: "Drag from one cell to another",
      description: `Press, move and release the mouse between two cells — for selections, sliders and drag-to-reorder lists. ${COORDINATES}`,
      inputSchema: {
        id: idSchema,
        x1: z.number().int().min(0).describe("Start column, 0-based."),
        y1: z.number().int().min(0).describe("Start row, 0-based."),
        x2: z.number().int().min(0).describe("End column, 0-based."),
        y2: z.number().int().min(0).describe("End row, 0-based."),
        button: z.enum(["left", "middle", "right"]).optional(),
        settleMs: z.number().int().min(0).max(60_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("drag", {
          id: await resolveId(params.id),
          x: params.x1,
          y: params.y1,
          x2: params.x2,
          y2: params.y2,
          button: params.button,
          quietMs: params.settleMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_scroll",
    {
      title: "Scroll with the wheel",
      description: `Send mouse-wheel events at a cell (usually the middle of the pane you want to scroll). ${COORDINATES}`,
      inputSchema: {
        id: idSchema,
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        direction: z.enum(["up", "down"]).describe("Wheel direction."),
        count: z.number().int().min(1).max(100).optional().describe("Number of notches, default 1."),
        settleMs: z.number().int().min(0).max(60_000).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("wheel", {
          id: await resolveId(params.id),
          x: params.x,
          y: params.y,
          direction: params.direction,
          count: params.count,
          quietMs: params.settleMs,
        });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_snapshot",
    {
      title: "Screenshot the screen as text",
      description: `Return the current screen without sending any input.

The screenshot is text by default and starts with a header such as:
# 100x30 alt cursor=4,9 settled=71ms title="app"
then one line per screen row, then an "# attrs" block listing highlighted spans (reverse video, colours, bold) — that block is how you see which row is selected or focused when the characters themselves are unchanged.

format="ansi" keeps the raw SGR colours (only useful if a human will look at it); format="json" returns cells, style runs and cursor as data. Set scrollback to include lines that scrolled off the top.`,
      inputSchema: {
        id: idSchema,
        format: z.enum(["text", "ansi", "json"]).optional().describe("Default text."),
        scrollback: z.number().int().min(0).max(2000).optional().describe("Extra lines above the viewport."),
        full: z.boolean().optional().describe("Keep trailing blank rows instead of trimming them."),
        attrs: z.boolean().optional().describe("Include the # attrs block (default true)."),
        header: z.boolean().optional().describe("Include the # header line (default true)."),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const c = await client();
        const snapshot = await c.call("snapshot", {
          id: await resolveId(params.id),
          ansi: params.format === "ansi",
          scrollback: params.scrollback,
          full: params.full,
          attrs: params.attrs,
          header: params.header,
        });
        const text =
          params.format === "json"
            ? JSON.stringify(snapshotToJson(snapshot))
            : params.format === "ansi"
              ? snapshot.ansi ?? snapshot.text
              : snapshot.text;
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_screenshot",
    {
      title: "Screenshot the screen as an image",
      description: `Render the screen to a PNG image and return it. Use this when colour, fonts or pixel-level layout are what matters — for reading text, terminal_snapshot is far cheaper and exact.

Save it with savePath (relative to the current workspace) to show the user.`,
      inputSchema: {
        id: idSchema,
        savePath: z.string().optional().describe("Write the PNG here and return the path."),
        scale: z.number().min(0.5).max(8).optional().describe("Pixel ratio, default 2."),
        fontSize: z.number().min(6).max(72).optional().describe("Font size in px, default 14."),
        showCursor: z.boolean().optional().describe("Draw the cursor block, default true."),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const c = await client();
        const result = await c.call("screenshot", {
          id: await resolveId(params.id),
          scale: params.scale,
          fontSize: params.fontSize,
          cursor: params.showCursor,
        });
        const content: ToolResult["content"] = [
          { type: "image", data: result.png, mimeType: "image/png" },
        ];
        if (params.savePath) {
          const target = isAbsolute(params.savePath) ? params.savePath : resolve(process.cwd(), params.savePath);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, Buffer.from(result.png, "base64"));
          content.push({ type: "text", text: `saved ${result.bytes} byte PNG to ${target}` });
        }
        return { content };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_wait",
    {
      title: "Wait for the screen",
      description: `Block until a condition holds, then return the screenshot. Use for anything slower than an instant repaint: builds, downloads, watchers, "Press any key" screens, apps that only settle after a second.

Conditions are combined with AND: text, regex, gone, idleMs, exit. On timeout the tool returns the current screenshot with met=false instead of failing, so you can inspect what happened.`,
      inputSchema: {
        id: idSchema,
        text: z.string().optional().describe("Wait until this literal text is on screen."),
        regex: z.string().optional().describe("Wait until this regular expression matches the screen."),
        gone: z.string().optional().describe("Wait until this text is no longer on screen."),
        idleMs: z.number().int().min(0).max(600_000).optional().describe("Wait for this much output silence."),
        exit: z.boolean().optional().describe("Wait for the process to exit."),
        timeoutMs: z.number().int().min(0).max(600_000).optional().describe("Default 10000."),
      },
      annotations: { readOnlyHint: true },
    },
    async (params) => {
      try {
        const c = await client();
        const result = await c.call(
          "wait",
          {
            id: await resolveId(params.id),
            text: params.text,
            regex: params.regex,
            gone: params.gone,
            quietMs: params.idleMs,
            exit: params.exit,
            timeoutMs: params.timeoutMs,
          },
          (params.timeoutMs ?? 10_000) + 20_000,
        );
        const status = result.met
          ? `# wait met after ${result.waitedMs}ms`
          : `# wait NOT met after ${result.waitedMs}ms${result.reason ? ` (${result.reason})` : ""}`;
        return { content: [{ type: "text", text: `${status}\n${result.snapshot.text}` }], isError: !result.met };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_resize",
    {
      title: "Resize the terminal",
      description: `Resize the pty and return the reflowed screen. TUIs often change layout below a width or height threshold, so this is also a way to test responsiveness.`,
      inputSchema: {
        id: idSchema,
        cols: z.number().int().min(1).max(1000),
        rows: z.number().int().min(1).max(500),
      },
      annotations: { readOnlyHint: false },
    },
    async (params) => {
      try {
        const c = await client();
        const action = await c.call("resize", { id: await resolveId(params.id), cols: params.cols, rows: params.rows });
        return { content: [{ type: "text", text: actionText(action) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_list",
    {
      title: "List terminals",
      description: `List open terminals with their id, size, screen type (alt = full-screen TUI), status, idle time and command. Also shows the final state of terminals that already exited — snapshot one before closing it if you need the last screen.`,
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const c = await client();
        const sessions = await c.call("list", {});
        if (!sessions.length) return { content: [{ type: "text", text: "no terminals open" }] };
        const lines = sessions.map(
          (s) =>
            `${s.id} · ${s.cols}x${s.rows}${s.altScreen ? " alt" : " main"} · ${
              s.exited ? `exited(${s.exitCode ?? "?"})` : "running"
            } · idle ${s.idleFor}s · ${[s.command, ...s.args].join(" ")}${s.title ? ` · "${s.title}"` : ""}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_close",
    {
      title: "Close a terminal",
      description: `Terminate the process and clean up. Returns the final screen first, because the last frame before exit is often the assertion you care about.`,
      inputSchema: { id: idSchema },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (params) => {
      try {
        const c = await client();
        const id = await resolveId(params.id);
        const snapshot: Snapshot = await c.call("snapshot", { id });
        await c.call("close", { id });
        return { content: [{ type: "text", text: `# closed ${id}\n${snapshot.text}` }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "terminal_run",
    {
      title: "Run a command to completion",
      description: `Open a terminal, run a command, wait for it to exit, and return the final screen plus the exit code. Then closes it.

Shortcut for one-shot CLI checks (build output, test failure, "does --help work"). For anything interactive use terminal_open plus the driving tools. Returns isError=true when the process exits non-zero.`,
      inputSchema: {
        command: z.string().describe("Executable to run."),
        args: z.array(z.string()).optional(),
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
        cols: z.number().int().min(1).max(1000).optional(),
        rows: z.number().int().min(1).max(500).optional(),
        timeoutMs: z.number().int().min(0).max(600_000).optional().describe("Default 30000."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (params) => {
      const c = await client();
      const timeout = params.timeoutMs ?? 30_000;
      const opened = await c.call("open", {
        command: params.command,
        args: params.args,
        cwd: params.cwd,
        env: params.env,
        cols: params.cols,
        rows: params.rows,
      });
      const id = opened.summary.id;
      try {
        const result = await c.call("wait", { id, exit: true, timeoutMs: timeout }, timeout + 20_000);
        const exitCode = result.snapshot.exitCode;
        const code = result.met ? exitCode ?? 0 : 124;
        const status = result.met
          ? `# exit ${code}`
          : `# still running after ${timeout}ms (killed)`;
        return {
          content: [{ type: "text", text: `${status}\n${result.snapshot.text}` }],
          isError: code !== 0,
        };
      } catch (error) {
        return errorResult(error);
      } finally {
        try {
          await c.call("close", { id });
        } catch {
          /* already gone */
        }
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
