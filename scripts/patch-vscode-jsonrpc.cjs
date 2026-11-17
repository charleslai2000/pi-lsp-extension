const fs = require("node:fs");
const path = require("node:path");

const target = process.env.VSCODE_JSONRPC_CONNECTION_PATH
  ? path.resolve(process.env.VSCODE_JSONRPC_CONNECTION_PATH)
  : path.resolve(
      __dirname,
      "../node_modules/vscode-jsonrpc/lib/common/connection.js",
    );
if (!fs.existsSync(target)) {
  console.error(`vscode-jsonrpc patch target not found: ${target}`);
  process.exit(1);
}

const source = fs.readFileSync(target, "utf8");
const requestStart = source.indexOf("sendRequest: (type");
const requestStartFallback = source.indexOf("sendRequest: (method");
const requestStartIndex =
  requestStart >= 0 ? requestStart : requestStartFallback;
const start = source.indexOf(
  "            return new Promise(async (resolve, reject) => {",
  requestStartIndex,
);
const endMarker = "            });\n        },\n        onRequest:";
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  const patched = source.includes(
    "Promise.resolve().then(() => messageWriter.write(requestMessage)).",
  );
  if (patched) {
    console.log("vscode-jsonrpc sendRequest rejection fix already applied");
    process.exit(0);
  }
  console.error(
    "Unexpected vscode-jsonrpc connection.js source; refusing to patch an unknown version",
  );
  process.exit(1);
}

const replacement = `            return new Promise((resolve, reject) => {
                const resolveWithCleanup = (r) => {
                    resolve(r);
                    cancellationStrategy.sender.cleanup(id);
                    disposable?.dispose();
                };
                const rejectWithCleanup = (r) => {
                    reject(r);
                    cancellationStrategy.sender.cleanup(id);
                    disposable?.dispose();
                };
                const responsePromise = { method: method, timerStart: Date.now(), resolve: resolveWithCleanup, reject: rejectWithCleanup };
                responsePromises.set(id, responsePromise);
                Promise.resolve().then(() => messageWriter.write(requestMessage)).catch((error) => {
                    responsePromises.delete(id);
                    responsePromise.reject(new messages_1.ResponseError(messages_1.ErrorCodes.MessageWriteError, error.message ? error.message : 'Unknown reason'));
                    logger.error(\`Sending request failed.\`);
                });
`;
fs.writeFileSync(
  target,
  source.slice(0, start) + replacement + source.slice(end),
);
console.log("Applied vscode-jsonrpc sendRequest rejection fix");
