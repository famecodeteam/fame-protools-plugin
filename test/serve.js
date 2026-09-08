// Serve the renderer for a browser test: node test/serve.js [adminKey]
// then open http://localhost:5052/ - the page gets test/browser-stub.js
// instead of Electron's preload, so the UI runs against production APIs
// with a fake Pro Tools. Use ?disconnected=1 to see the no-Pro-Tools state.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const adminKey = process.argv[2] || process.env.FAME_ADMIN_KEY || "";
const port = Number(process.env.PORT) || 5052;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = url.pathname === "/" ? "/src/renderer/index.html" : url.pathname;
  if (p.startsWith("/renderer/")) p = "/src" + p;
  let file = path.join(root, p);
  // index.html references app.css / app.js relative to itself
  if (!fs.existsSync(file) && fs.existsSync(path.join(root, "src", "renderer", p))) file = path.join(root, "src", "renderer", p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  let body = fs.readFileSync(file);
  if (p.endsWith("index.html")) {
    body = body.toString()
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
      .replace('<script src="../core/mapping.js"></script>',
        '<script>window.__FAME_ADMIN_KEY__=' + JSON.stringify(adminKey) + ';window.__FAME_DISCONNECTED__=' + (url.searchParams.get("disconnected") ? "true" : "false") + ';</script>' +
        '<script src="/src/core/mapping.js"></script><script src="/test/browser-stub.js"></script>');
  }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  res.end(body);
}).listen(port, () => console.log("renderer at http://localhost:" + port + "/  (admin key " + (adminKey ? "set" : "NOT set") + ")"));
