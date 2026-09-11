// Serves the repository over http so tools/uiHarness.html can load the bundled
// webview and the sample URDF in a normal browser (file:// blocks the fetch).
//
//   node tools/serveHarness.js      ->  prints the harness URL
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const root = path.join(__dirname, "..");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".urdf": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
  const file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`http://127.0.0.1:${port}/tools/uiHarness.html`);
});
