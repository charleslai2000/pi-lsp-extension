import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node.js";

const input = new PassThrough();
const output = new PassThrough();
const connection = createMessageConnection(
  new StreamMessageReader(input),
  new StreamMessageWriter(output),
);
connection.onError(() => {});
connection.listen();
output.destroy();

let uncaught: unknown;
const onUncaught = (error: unknown) => {
  uncaught = error;
};
process.on("uncaughtException", onUncaught);
try {
  await assert.rejects(
    connection.sendRequest("textDocument/definition", {}),
    (error: unknown) =>
      error instanceof Error &&
      /Cannot call write after a stream was destroyed/.test(error.message),
  );
  await delay(25);
  assert.equal(
    uncaught,
    undefined,
    "A failed JSON-RPC write must not escape as uncaughtException",
  );
} finally {
  process.off("uncaughtException", onUncaught);
  connection.dispose();
}

console.log("JSON-RPC destroyed-stream request failure is handled");
