// Small helpers for the admin view. No framework, no build step.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'value' && (tag === 'input' || tag === 'select')) el.value = value;
    else if (key === 'checked' || key === 'selected') el[key] = Boolean(value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, rawBody } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-requested-with': 'admin',
        ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError("Couldn't reach the site. Check your connection and try again.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `The request failed (${res.status}).`, res.status);
  return data;
}

// Front matter: one `key: <JSON>` per line. That is valid YAML, and simple to read back.
const DOC_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

function parseValue(raw) {
  const s = raw.trim();
  if (s === '') return '';
  try { return JSON.parse(s); } catch { /* plain YAML scalar */ }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (s === 'true' || s === 'false') return s === 'true';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFields(block) {
  const data = {};
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#') || line === '---') continue;
    const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
    if (m) data[m[1]] = parseValue(m[2]);
  }
  return data;
}

export function parseDoc(text) {
  const m = String(text || '').match(DOC_RE);
  if (!m) return { data: {}, body: String(text || '').trim() };
  return { data: parseFields(m[1]), body: m[2].trim() };
}

export function serializeFields(data) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
}

export function serializeDoc(data, body = '') {
  const text = (body || '').trim();
  return `---\n${serializeFields(data)}\n---\n${text ? `${text}\n` : ''}`;
}

export const RESERVED = new Set(['admin', 'api', 'work', 'for', 'about', 'search', 'files', 'assets', 'r', '404', 'index', 'new']);

export function slugify(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}

export function safeFileName(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const stem = slugify(dot > 0 ? name.slice(0, dot) : name) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error(`Couldn't read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function inline(s) {
  return escapeHtml(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

// A rough Markdown preview for the editor. The site itself uses a full Markdown renderer when it builds.
export function markdownPreview(text, keepBreaks = false) {
  const blocks = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map((block) => {
    const lines = block.split('\n');
    const heading = block.match(/^(#{1,4})\s+(.*)$/);
    if (heading && lines.length === 1) return `<h${heading[1].length + 1}>${inline(heading[2])}</h${heading[1].length + 1}>`;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    if (lines.every((l) => /^>\s?/.test(l))) return `<blockquote><p>${lines.map((l) => inline(l.replace(/^>\s?/, ''))).join(keepBreaks ? '<br>' : ' ')}</p></blockquote>`;
    return `<p>${lines.map(inline).join(keepBreaks ? '<br>' : ' ')}</p>`;
  }).join('');
}

export function byOrder(a, b) {
  return (Number(a.order) || 99) - (Number(b.order) || 99) || String(a.title || '').localeCompare(String(b.title || ''));
}

export const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(s) {
  const m = String(s || '').match(/^(\d{4})(?:-(\d{2}))?/);
  if (!m) return '';
  return m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : m[1];
}
