import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const host = "127.0.0.1";
const usage = "用法：node demo/server.mjs [--port 4175]";
const files = new Map([
  ["/", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/index.html", { name: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { name: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { name: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/scenarios.js", { name: "scenarios.js", type: "text/javascript; charset=utf-8" }],
]);

function parsePort(args) {
  if (args.length === 0) return 4175;
  if (args.length !== 2 || args[0] !== "--port" || !/^\d+$/.test(args[1])) {
    throw new Error(usage);
  }
  const port = Number(args[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口必须是 1 到 65535 之间的整数。\n" + usage);
  }
  return port;
}

function reply(request, response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

function main() {
  let port;
  try {
    port = parsePort(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      reply(request, response, 405, "仅支持 GET 和 HEAD 请求。\n", { Allow: "GET, HEAD" });
      return;
    }

    let pathname;
    try {
      pathname = new URL(request.url, `http://${host}:${port}`).pathname;
    } catch {
      reply(request, response, 400, "请求地址无效。\n");
      return;
    }

    const file = files.get(pathname);
    if (!file) {
      reply(request, response, 404, "未找到页面。\n");
      return;
    }

    try {
      const body = await readFile(new URL(file.name, import.meta.url));
      reply(request, response, 200, body, { "Content-Type": file.type });
    } catch (error) {
      if (error.code === "ENOENT") {
        reply(request, response, 404, "演示文件不存在，请检查 demo 目录是否完整。\n");
      } else {
        console.error(`读取演示文件 ${file.name} 失败：${error.message}`);
        reply(request, response, 500, "暂时无法读取演示文件。\n");
      }
    }
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。请尝试：node demo/server.mjs --port ${port === 65535 ? 4176 : port + 1}`);
    } else {
      console.error(`演示服务启动失败：${error.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`DSH × Codex 本地演示：http://${host}:${port}/`);
    console.log("仅提供本地模拟页面，不连接模型或 DSH。按 Ctrl+C 停止。");
  });
}

main();
