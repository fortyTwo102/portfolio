import { json, error, safeEqual, createSession, sessionCookie, missingSettings } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const problem = missingSettings(env, ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'SESSION_SECRET']);
  if (problem) return error(500, problem);

  let body;
  try { body = await request.json(); } catch { return error(400, 'Enter the username and password.'); }

  const userOk = safeEqual(String(body.username || '').trim().toLowerCase(), env.ADMIN_USERNAME.trim().toLowerCase());
  const passOk = safeEqual(String(body.password || ''), env.ADMIN_PASSWORD);
  if (!userOk || !passOk) {
    await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
    return error(401, "That username and password don't match. Check them and try again.");
  }

  const name = String(body.name || '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40) || 'Admin';
  return json({ name }, 200, { 'set-cookie': sessionCookie(await createSession(env, name)) });
}
