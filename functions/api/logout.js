import { json, sessionCookie } from '../../lib/server.js';

export function onRequestPost() {
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
}
