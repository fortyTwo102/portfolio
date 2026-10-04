import { json, error, readSession } from '../../lib/server.js';

export async function onRequestGet({ request, env }) {
  const session = await readSession(request, env);
  return session ? json(session) : error(401, 'Not logged in.');
}
