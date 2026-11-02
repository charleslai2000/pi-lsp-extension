import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LSPManager } from "../lsp-core.js";
import { withTimeout } from "../lsp-tool.js";

const TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = TIMEOUT_MS + 10_000;

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(join(tmpdir(), "lsp-workspace-symbol-timeout-"));
  const root = join(tempRoot, "repo");
  const serverScript = join(tempRoot, "stalled-lsp-server.mjs");
  const serverEvents = join(tempRoot, "server-events.log");
  const reportFile = join(tempRoot, "e2e-result.json");
  let manager: LSPManager | undefined;
  let fakeServer: ChildProcess | undefined;
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "Cargo.toml"), '[package]\nname="timeout-fixture"\nversion="0.1.0"\nedition="2024"\n');
    await writeFile(join(root, "src", "lib.rs"), "pub fn probe() {}\n");
    await writeFile(serverScript, `
import { appendFileSync } from "node:fs";
const log = ${JSON.stringify(serverEvents)};
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]));
}
function handle(message) {
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { workspaceSymbolProvider: true, textDocumentSync: 1 } } });
  } else if (message.method === "workspace/symbol") {
    appendFileSync(log, "workspace-symbol\\n");
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: [] }), 120000);
  } else if (message.method === "$/cancelRequest") {
    appendFileSync(log, "cancel-request\\n");
  } else if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  } else if (message.method === "exit") {
    process.exit(0);
  } else if (Object.hasOwn(message, "id")) {
    send({ jsonrpc: "2.0", id: message.id, result: null });
  }
}
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const split = buffer.indexOf("\\r\\n\\r\\n");
    if (split < 0) break;
    const header = buffer.subarray(0, split).toString();
    const length = Number(header.match(/Content-Length: (\\d+)/i)?.[1]);
    if (!Number.isFinite(length) || buffer.length < split + 4 + length) break;
    const body = buffer.subarray(split + 4, split + 4 + length);
    buffer = buffer.subarray(split + 4 + length);
    handle(JSON.parse(body.toString()));
  }
});
`);
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({
      lsp: { enabled: true, servers: { "rust-analyzer": { command: process.execPath, args: [serverScript], rootMarkers: ["Cargo.toml"] } } },
    }));

    manager = new LSPManager(root);
    const startedAt = Date.now();
    const operation = withTimeout(
      token => manager!.getWorkspaceSymbols(join(root, "src", "lib.rs"), "", token),
      TIMEOUT_MS,
      "workspaceSymbol",
    );
    await assert.rejects(
      Promise.race([
        operation,
        new Promise((_, reject) => setTimeout(() => reject(new Error("tool remained blocked beyond timeout window")), TEST_TIMEOUT_MS)),
      ]),
      /timed out after 30000ms/,
    );
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs >= TIMEOUT_MS - 1500 && elapsedMs < TEST_TIMEOUT_MS, `Unexpected timeout duration ${elapsedMs}ms`);
    let eventText = await readFile(serverEvents, "utf8");
    assert.match(eventText, /workspace-symbol/, "Fake server must receive workspace/symbol before timeout");
    await new Promise(resolve => setTimeout(resolve, 250));
    eventText = await readFile(serverEvents, "utf8");
    assert.match(eventText, /cancel-request/, "Fake server must receive $/cancelRequest after timeout");

    fakeServer = spawn(process.execPath, [serverScript]);
    const abortManager = new LSPManager(root);
    try {
      const abortClients = await abortManager.getClientsForFile(join(root, "src", "lib.rs"));
      assert(abortClients.length > 0, "Expected a separately managed LSP client for user-cancel scenario");
      const controller = new AbortController();
      const abortStarted = Date.now();
      const abortedRequest = withTimeout(
        token => abortManager.getWorkspaceSymbols(join(root, "src", "lib.rs"), "", token),
        TIMEOUT_MS,
        "workspaceSymbol",
        controller.signal,
      );
      for (let i = 0; i < 100; i++) {
        try {
          eventText = await readFile(serverEvents, "utf8");
          if ((eventText.match(/workspace-symbol/g) ?? []).length >= 2) break;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert((eventText.match(/workspace-symbol/g) ?? []).length >= 2, "Fake server did not receive second workspace/symbol request");
      controller.abort();
      await assert.rejects(abortedRequest, /aborted/);
      const abortElapsedMs = Date.now() - abortStarted;
      assert(abortElapsedMs < 5000, `Caller abort did not release Pi promptly: ${abortElapsedMs}ms`);
      for (let i = 0; i < 100; i++) {
        eventText = await readFile(serverEvents, "utf8");
        if ((eventText.match(/cancel-request/g) ?? []).length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert((eventText.match(/cancel-request/g) ?? []).length >= 2, "Fake server did not receive caller cancellation");
      await writeFile(reportFile, JSON.stringify({ result: "PASS", timeoutElapsedMs: elapsedMs, abortElapsedMs, events: eventText.trim().split("\\n") }, null, 2));
      console.log(await readFile(reportFile, "utf8"));
    } finally {
      await abortManager.shutdown();
    }
  } finally {
    await manager?.shutdown();
    if (fakeServer && fakeServer.exitCode === null) {
      fakeServer.kill("SIGTERM");
      await Promise.race([once(fakeServer, "exit"), new Promise(resolve => setTimeout(resolve, 2000))]);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
