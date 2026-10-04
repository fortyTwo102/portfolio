// Everything under /admin needs a session, except the login page and its files.
import { readSession } from '../../lib/server.js';

const OPEN = new Set(['/admin/login', '/admin/login.html', '/admin/login.js', '/admin/admin.css']);

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (!OPEN.has(path) && !(await readSession(request, env))) {
    return Response.redirect(new URL('/admin/login', url).toString(), 302);
  }
  const res = await next();
  const out = new Response(res.body, res);
  out.headers.set('cache-control', 'no-store');
  out.headers.set('x-robots-tag', 'noindex, nofollow');
  out.headers.set('x-frame-options', 'DENY');
  out.headers.set('referrer-policy', 'same-origin');
  return out;
}
