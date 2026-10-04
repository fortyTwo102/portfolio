// Shared code for the admin API (Cloudflare Pages Functions).
// Sessions are signed cookies; GitHub calls use a token that only lives in Cloudflare's settings.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const COOKIE = '__Host-ay_session';
const SESSION_DAYS = 30;

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function error(status, message) {
  return json({ error: message }, status);
}

export function missingSettings(env, names) {
  const missing = names.filter((n) => !env[n]);
  return missing.length
    ? `The admin view isn't set up yet. Add ${missing.join(', ')} under Settings → Variables and Secrets in the Cloudflare Pages project, then redeploy.`
    : null;
}

function toB64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sign(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

// Compare without leaking how many characters matched.
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Changing ADMIN_PASSWORD (or SESSION_SECRET) signs everyone out.
const signingSecret = (env) => `${env.SESSION_SECRET}:${env.ADMIN_PASSWORD}`;

export async function createSession(env, name) {
  const payload = toB64url(enc.encode(JSON.stringify({ n: name, e: Date.now() + SESSION_DAYS * 864e5 })));
  return `${payload}.${await sign(signingSecret(env), payload)}`;
}

export function sessionCookie(value, maxAge = SESSION_DAYS * 86400) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export async function readSession(request, env) {
  if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) return null;
  const match = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, await sign(signingSecret(env), payload))) return null;
  try {
    const data = JSON.parse(dec.decode(fromB64url(payload)));
    return data && data.e > Date.now() ? { name: data.n || 'Admin' } : null;
  } catch {
    return null;
  }
}

// Every API route except login goes through this. Writes also need a custom header,
// which a cross-site form can't send, on top of the SameSite=Strict cookie.
export async function requireAdmin(request, env) {
  const session = await readSession(request, env);
  if (!session) return { response: error(401, 'Your session has ended. Log in again.') };
  if (request.method !== 'GET' && request.headers.get('x-requested-with') !== 'admin') {
    return { response: error(403, 'This request did not come from the admin view.') };
  }
  return { session };
}

export const GITHUB_SETTINGS = ['GITHUB_TOKEN', 'GITHUB_REPO'];

export function github(env) {
  const api = (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'ammara-portfolio-admin',
    'x-github-api-version': '2022-11-28',
  };

  async function call(method, path, body) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    if (!res.ok) {
      const err = new Error((data && data.message) || `GitHub returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    api, repo, branch, headers, call,
    async head() {
      const ref = await call('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return ref.object.sha;
    },
    async treeOf(commitSha) {
      const commit = await call('GET', `/repos/${repo}/git/commits/${commitSha}`);
      return commit.tree.sha;
    },
    createTree: (baseTree, tree) => call('POST', `/repos/${repo}/git/trees`, { base_tree: baseTree, tree }),
    createCommit: (message, tree, parents, author) => call('POST', `/repos/${repo}/git/commits`, { message, tree, parents, author }),
    updateRef: (sha) => call('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false }),
    graphql: (query, variables) => call('POST', '/graphql', { query, variables }),
  };
}

// Turn GitHub failures into messages an editor can act on.
export function githubError(err) {
  const status = err && err.status;
  if (status === 401) return error(502, 'GitHub rejected the access token. It may have expired: create a new one and update GITHUB_TOKEN in Cloudflare.');
  if (status === 403 || status === 404) return error(502, 'The access token can\'t reach the repository. Check that GITHUB_REPO is right and the token has "Contents: read and write" on that repository.');
  if (status === 409 || status === 422) return error(409, 'The site changed while you were saving. Reload the admin view and make your change again.');
  return error(502, `GitHub didn't respond as expected (${(err && err.message) || 'unknown error'}). Try again in a minute.`);
}

export function commitAuthor(env, name) {
  return {
    name: `${name} (admin view)`,
    email: env.COMMIT_EMAIL || 'admin-view@users.noreply.github.com',
    date: new Date().toISOString(),
  };
}

// Paths the admin view may write. Everything else in the repo is code.
export function allowedPath(path) {
  return typeof path === 'string'
    && /^(content\/[a-z0-9-]+(\/[a-z0-9-]+)?\.(md|yml)|public\/files\/[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*)$/.test(path)
    && !path.includes('..');
}
