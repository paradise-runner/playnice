import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = fileURLToPath(new URL("../cli/index.js", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "playnice-mcp-"));

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) env[key] = value;
}
env.PLAYNICE_HOME = HOME;
env.NO_COLOR = "1";

let client: Client | undefined;

after(async () => {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  // The MCP server spawns (and leaves behind) a daemon; stop it so the test
  // run does not leave a process holding a deleted socket path.
  try {
    execFileSync(process.execPath, [CLI, "daemon", "stop"], { env, timeout: 20_000, stdio: "ignore" });
  } catch {
    /* already gone */
  }
  rmSync(HOME, { recursive: true, force: true });
});

function text(result: unknown): string {
  const response = result as { content: Array<{ type: string; text?: string }> };
  return response.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

test("mcp: tools are discoverable and drive a terminal", { timeout: 120_000 }, async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "mcp"],
    env,
  });
  client = new Client({ name: "playnice-test", version: "1.0.0" });
  await client.connect(transport);

  await t.test("lists the full tool surface with useful descriptions", async () => {
    const tools = await client!.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "terminal_click",
      "terminal_close",
      "terminal_drag",
      "terminal_key",
      "terminal_list",
      "terminal_open",
      "terminal_paste",
      "terminal_resize",
      "terminal_run",
      "terminal_screenshot",
      "terminal_scroll",
      "terminal_send",
      "terminal_snapshot",
      "terminal_type",
      "terminal_wait",
    ]);
    const open = tools.tools.find((tool) => tool.name === "terminal_open")!;
    assert.match(open.description ?? "", /pseudo-terminal/);
    assert.match(open.description ?? "", /100x30/);
    assert.ok(open.inputSchema.properties?.command);
  });

  await t.test("open returns the first screen", async () => {
    const result = await client!.callTool({
      name: "terminal_open",
      arguments: { command: "/bin/sh", cols: 60, rows: 12, id: "mcp" },
    });
    const body = text(result);
    assert.match(body, /60x12 main/);
    assert.match(body, /mcp · 60x12/);
  });

  await t.test("send reports change status and the resulting screen", async () => {
    const result = await client!.callTool({
      name: "terminal_send",
      arguments: { id: "mcp", text: "echo tool-roundtrip" },
    });
    const body = text(result);
    assert.match(body, /^# action changed=true/);
    assert.match(body, /tool-roundtrip/);
  });

  await t.test("keys work without Enter", async () => {
    const result = await client!.callTool({
      name: "terminal_key",
      arguments: { id: "mcp", keys: ["C-c"] },
    });
    assert.match(text(result), /changed=true/);
  });

  await t.test("snapshot defaults to text and can emit JSON", async () => {
    const plain = await client!.callTool({
      name: "terminal_snapshot",
      arguments: { id: "mcp" },
    });
    assert.match(text(plain), /^# 60x12 main/);
    const json = await client!.callTool({
      name: "terminal_snapshot",
      arguments: { id: "mcp", format: "json" },
    });
    const parsed = JSON.parse(text(json)) as { session: string; lines: string[] };
    assert.equal(parsed.session, "mcp");
    assert.ok(Array.isArray(parsed.lines));
  });

  await t.test("wait times out as data, not as an error", async () => {
    const result = await client!.callTool({
      name: "terminal_wait",
      arguments: { id: "mcp", text: "absent-text", timeoutMs: 200 },
    });
    assert.match(text(result), /NOT met/);
    assert.equal((result as { isError?: boolean }).isError, true);
  });

  await t.test("screenshot returns a PNG image part", async () => {
    const result = (await client!.callTool({
      name: "terminal_screenshot",
      arguments: { id: "mcp", scale: 1 },
    })) as { content: Array<{ type: string; data?: string; mimeType?: string }> };
    const image = result.content.find((part) => part.type === "image");
    assert.ok(image, "expected an image content part");
    assert.equal(image!.mimeType, "image/png");
    assert.ok((image!.data ?? "").length > 1000);
  });

  await t.test("run returns the exit code and closes the session", async () => {
    const result = await client!.callTool({
      name: "terminal_run",
      arguments: { command: "/bin/sh", args: ["-c", "echo ran; exit 4"], cols: 40, rows: 8 },
    });
    assert.match(text(result), /^# exit 4/);
    assert.match(text(result), /ran/);
    assert.equal((result as { isError?: boolean }).isError, true);
  });

  await t.test("list and close", async () => {
    const list = await client!.callTool({ name: "terminal_list", arguments: {} });
    assert.match(text(list), /^mcp · 60x12/m);
    const closed = await client!.callTool({
      name: "terminal_close",
      arguments: { id: "mcp" },
    });
    assert.match(text(closed), /# closed mcp/);
    const empty = await client!.callTool({ name: "terminal_list", arguments: {} });
    assert.match(text(empty), /no terminals open/);
  });
});
