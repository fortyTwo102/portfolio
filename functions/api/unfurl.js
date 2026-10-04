// Fetch a page's preview details (title, description, image) and its Wayback Machine copy.
import { json, error, requireAdmin } from '../../lib/server.js';

const LIMIT = 400 * 1024; // only the <head> matters

async function fetchWithTimeout(url, init = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readStart(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < LIMIT) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, size - at)), at); at += c.length; if (at >= size) break; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHead(html) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !(key in meta)) meta[key] = decode(attrs.content);
  }
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  return { meta, title: decode(title) };
}

async function wayback(url, waitUntil) {
  try {
    const res = await fetchWithTimeout(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, 6000);
    const data = await res.json();
    const snap = data && data.archived_snapshots && data.archived_snapshots.closest;
    if (snap && snap.available && snap.url) return { archive: snap.url.replace(/^http:/, 'https:'), archiveRequested: false };
  } catch { /* the archive is best effort */ }
  // No copy yet: ask the Wayback Machine to save one, without making the editor wait.
  waitUntil(fetchWithTimeout(`https://web.archive.org/save/${url}`, {}, 25000).catch(() => {}));
  return { archive: '', archiveRequested: true };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;

  let target;
  try {
    target = new URL(new URL(request.url).searchParams.get('url') || '');
  } catch {
    return error(400, 'Enter a full link that starts with https://');
  }
  if (!/^https?:$/.test(target.protocol)) return error(400, 'Enter a full link that starts with https://');

  const [page, archived] = await Promise.all([
    (async () => {
      try {
        const res = await fetchWithTimeout(target.toString(), {
          redirect: 'follow',
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; PortfolioLinkPreview/1.0; +https://ammara-younas.pages.dev)', accept: 'text/html,application/xhtml+xml' },
        });
        if (!res.ok) return { problem: `The page answered with status ${res.status}.` };
        if (!/html/i.test(res.headers.get('content-type') || '')) return { problem: "That link isn't a web page, so there's no preview to fetch." };
        return { finalUrl: res.url || target.toString(), ...parseHead(await readStart(res)) };
      } catch {
        return { problem: "The page didn't respond. You can still fill in the title and description yourself." };
      }
    })(),
    wayback(target.toString(), waitUntil || (() => {})),
  ]);

  const m = page.meta || {};
  let image = m['og:image'] || m['og:image:url'] || m['twitter:image'] || '';
  try { image = image ? new URL(image, page.finalUrl || target).toString() : ''; } catch { image = ''; }
  if (!image.startsWith('https://')) image = '';

  return json({
    url: target.toString(),
    title: m['og:title'] || m['twitter:title'] || page.title || '',
    description: m['og:description'] || m['twitter:description'] || m.description || '',
    site: m['og:site_name'] || target.hostname.replace(/^www\./, ''),
    image,
    ...archived,
    problem: page.problem || '',
  });
}
