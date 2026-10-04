// Upload one file to the repository as a Git blob. The browser sends {"content": <base64>, "encoding": "base64"};
// the body is streamed straight to GitHub so large files don't use up the function's CPU time.
import { json, error, requireAdmin, github, missingSettings, GITHUB_SETTINGS } from '../../lib/server.js';

const MAX_BODY = 36 * 1024 * 1024; // about 25 MB before base64

export async function onRequestPost({ request, env }) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  const problem = missingSettings(env, GITHUB_SETTINGS);
  if (problem) return error(500, problem);

  const length = Number(request.headers.get('content-length') || 0);
  if (!length) return error(411, 'The upload was empty.');
  if (length > MAX_BODY) return error(413, 'That file is too large. Files must be 20 MB or smaller.');

  const gh = github(env);
  const init = {
    method: 'POST',
    headers: { ...gh.headers, 'content-type': 'application/json', 'content-length': String(length) },
    body: request.body,
  };
  // Node (the local preview) needs this flag to stream a request body; Cloudflare doesn't use it.
  if (typeof navigator === 'undefined' || navigator.userAgent !== 'Cloudflare-Workers') init.duplex = 'half';
  const res = await fetch(`${gh.api}/repos/${gh.repo}/git/blobs`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.sha) return error(502, `GitHub didn't accept the file (${data.message || res.status}). Try again.`);
  return json({ sha: data.sha });
}
