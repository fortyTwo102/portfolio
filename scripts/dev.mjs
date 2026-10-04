// Local preview of the whole site, admin view included, without Cloudflare.
//   python build.py && node scripts/dev.mjs
// Settings come from .dev.vars (KEY=value per line), the same names as in Cloudflare.
// It serves dist/ like Cloudflare Pages does and runs the files in functions/ for /api and /admin.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const DIST = path.resolve(process.env.DIST || 'dist');
const PORT = Number(process.env.PORT || 8788);

const env = {};
const varsFile = path.resolve(ROOT, process.env.VARS || '.dev.vars');
if (existsSync(varsFile)) {
  for (const line of readFileSync(varsFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

// Static files with Cloudflare Pages' pretty URLs: /about/ -> about/index.html, /admin/login -> admin/login.html.
async function serveStatic(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel.includes('..')) return new Response('Bad path', { status: 400 });
  let file = path.join(DIST, rel);
  if (rel.endsWith('/')) file = path.join(file, 'index.html');
  if (!(await isFile(file))) {
    if (await isFile(`${file}.html`)) file = `${file}.html`;
    else if (await isFile(path.join(file, 'index.html'))) return Response.redirect(`${url.origin}${rel}/`, 308);
    else {
      const notFound = path.join(DIST, '404.html');
      return new Response(await readFile(notFound).catch(() => 'Not found'), { status: 404, headers: { 'content-type': TYPES['.html'] } });
    }
  }
  return new Response(await readFile(file), { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
}

const modules = new Map();
async function load(file) {
  if (!modules.has(file)) modules.set(file, await import(pathToFileURL(file).href));
  return modules.get(file);
}

async function runFunction(file, request) {
  const mod = await load(file);
  const method = request.method.charAt(0) + request.method.slice(1).toLowerCase();
  const handler = mod[`onRequest${method}`] || mod.onRequest;
  if (!handler) return new Response('Method not allowed', { status: 405 });
  return handler({ request, env, params: {}, next: () => serveStatic(request), waitUntil: (p) => Promise.resolve(p).catch(() => {}) });
}

async function handle(request) {
  const { pathname } = new URL(request.url);
  const api = pathname.match(/^\/api\/([a-z-]+)$/);
  if (api) {
    const file = path.join(ROOT, 'functions', 'api', `${api[1]}.js`);
    return existsSync(file) ? runFunction(file, request) : new Response('Not found', { status: 404 });
  }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return runFunction(path.join(ROOT, 'functions', 'admin', '[[path]].js'), request);
  return serveStatic(request);
}

http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host}${req.url}`;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
    const response = await handle(request);
    const headers = {};
    response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.stack));
  }
}).listen(PORT, () => console.log(`Portfolio preview on http://localhost:${PORT} (admin at /admin)`));
