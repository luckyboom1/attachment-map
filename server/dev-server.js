/**
 * 本地开发服务器 —— 零依赖（只用 Node 内置模块）
 * ===========================================================================
 * 用法：node server/dev-server.js  [--port 5173] [--api]
 *
 * 它做两件事：
 *   1. 以项目根目录为根，提供静态文件（带正确的 MIME，ES Modules 才能跑）
 *   2. 可选地挂载 /api/v1/* 的桩实现，用来验证前端切到 remote 模式后
 *      是否真的能跑通（默认关闭，因为当前是免费本地模式）
 *
 * 为什么不用 npm 装个 serve/vite：
 *   这个阶段引入任何依赖都会让「部署到免费静态托管」多一步构建。
 *   零依赖 = 把整个目录拖到 Cloudflare Pages / GitHub Pages 就能跑。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(join(__dirname, '..'));

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argOf('port', process.env.PORT || 5173));
const ENABLE_API = argv.includes('--api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * 防目录穿越：解析后的绝对路径必须仍在 ROOT 之内。
 *
 * 安全性说明（2026-09-12 加固）：原实现直接调用 decodeURIComponent，
 * 遇到畸形百分号编码（如 `/%ZZ`、`/%E0%A4%A`）会抛 URIError。
 * 该异常发生在请求处理链上且未被捕获，会**直接终止整个 Node 进程**——
 * 也就是说，一个精心构造的 URL 就能远程打掉这个服务。
 * 现在改为：解码失败一律视为非法路径（返回 403），并额外拒绝空字节。
 */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;                       // 畸形编码 = 非法路径，不抛异常
  }
  if (decoded.includes('\0')) return null;   // 空字节截断
  const target = resolve(join(root, normalize(decoded)));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(req, res) {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = safeJoin(ROOT, pathname);
  if (!file) return send(res, 403, '禁止访问');

  try {
    const info = await stat(file);
    if (info.isDirectory()) return send(res, 403, '这是一个目录');

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',      // 开发期不用缓存，避免改了看不到
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, '找不到这个页面');
  }
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/* --------------------------- API 桩（可选） --------------------------- */
/**
 * 这些桩的唯一目的是：验证前端把 CONFIG.mode 改成 'remote' 之后，
 * 请求路径、错误码、数据结构是否与契约一致。
 * 它们不实现任何业务逻辑，也没有持久化。
 */
async function handleApi(req, res, pathname) {
  const { NORMS } = await import('../assets/js/core/norms.js');
  const { score } = await import('../assets/js/core/scoring.js');

  if (req.method === 'GET' && pathname === '/api/v1/stats/norms') {
    return json(res, 200, {
      version: NORMS.version,
      source: NORMS.source,
      anxiety: NORMS.anxiety,
      avoidance: NORMS.avoidance,
      citation: NORMS.citation,
      provisionalNote: NORMS.provisionalNote,
    });
  }

  if (req.method === 'POST' && pathname === '/api/v1/results') {
    const body = await readBody(req);
    if (!body?.answers || typeof body.answers !== 'object') {
      return json(res, 400, { message: 'answers 字段缺失或格式不正确。' });
    }
    const r = score(body.answers);
    return json(res, 201, {
      resultId: `stub_${Date.now().toString(36)}`,
      A: r.A, V: r.V, zA: r.zA, zV: r.zV,
      type: r.type,
      normsVersion: r.normsVersion,
    });
  }

  if (req.method === 'GET' && pathname === '/api/v1/entitlements') {
    return json(res, 200, { single: true, duo: true, orders: [] });   // 桩：一律已解锁
  }

  if (req.method === 'POST' && pathname === '/api/v1/orders') {
    const body = await readBody(req);
    const amount = body?.plan === 'duo' ? 2990 : 990;
    return json(res, 201, {
      orderId: `stub_order_${Date.now().toString(36)}`,
      plan: body?.plan || 'single',
      amountCents: amount,
      currency: 'CNY',
      status: 'paid',
      payUrl: null,
      createdAt: new Date().toISOString(),
    });
  }

  if (req.method === 'POST' && pathname === '/api/v1/events') {
    const body = await readBody(req);
    const n = Array.isArray(body?.events) ? body.events.length : 1;
    console.log(`  [api:stub] 收到 ${n} 条埋点`);
    return json(res, 202, { accepted: n });
  }

  if (req.method === 'POST' && pathname === '/api/v1/redeem') {
    return json(res, 200, { single: true, duo: false, orders: ['stub_redeem'] });
  }

  return json(res, 501, {
    message: '该端点在桩服务里尚未实现。当前为前端本地运行模式，无需后端。',
    code: 'NOT_IMPLEMENTED',
  });
}

/* ------------------------------- 启动 ------------------------------- */

/**
 * 请求入口。
 * 整体包一层 try/catch：任何未预期异常都只影响当前这一个请求，
 * 不再有机会终止进程（`new URL(req.url, ...)` 对畸形输入同样会抛）。
 */
const server = createServer(async (req, res) => {
  try {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(res, 400, '请求地址无法解析');
    }

    if (pathname.startsWith('/api/')) {
      if (!ENABLE_API) {
        return json(res, 501, {
          message: '本地模式未启用 API 桩。需要验证时用：node server/dev-server.js --api',
          code: 'NOT_IMPLEMENTED',
        });
      }
      try { return await handleApi(req, res, pathname); }
      catch (e) { return json(res, 500, { message: String(e?.message || e) }); }
    }

    return await serveStatic(req, res);
  } catch (err) {
    // 兜底：日志留在服务端，响应只给通用信息，不回显内部细节
    console.error('  [error] 请求处理失败：', err?.message || err);
    if (!res.headersSent) return send(res, 500, '服务内部错误');
    try { res.end(); } catch { /* ignore */ }
  }
});

/**
 * 客户端错误（畸形 HTTP 报文、请求头超长等）默认会销毁 socket；
 * 这里显式兜住，避免 Node 打印堆栈或进程退出。
 */
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  else socket.destroy();
});

/** 单次请求最长处理时间，防止慢速请求长期占用连接 */
server.requestTimeout = 30000;
server.headersTimeout = 20000;

server.listen(PORT, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${PORT}`;
  console.log('');
  console.log('  依恋地图 · 本地开发服务器');
  console.log('  ' + '─'.repeat(46));
  console.log(`  入口        ${base}/index.html`);
  console.log(`  方法说明    ${base}/about.html`);
  console.log(`  API 桩      ${ENABLE_API ? '已启用' : '未启用（加 --api 开启）'}`);
  console.log('  ' + '─'.repeat(46));
  console.log('  按 Ctrl+C 停止');
  console.log('');
});
