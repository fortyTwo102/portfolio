// Public setup check, shown on the login page. It reports which settings are missing and whether the
// GitHub key can reach the repository. It never returns the values themselves.
import { json, github, REQUIRED_SETTINGS } from '../../lib/server.js';

export async function onRequestGet({ env }) {
  const missing = REQUIRED_SETTINGS.filter((n) => !env[n]);
  let githubStatus = 'not checked';
  if (env.GITHUB_TOKEN) {
    try {
      const gh = github(env);
      const repo = await gh.call('GET', `/repos/${gh.repo}`);
      githubStatus = repo && repo.permissions && repo.permissions.push === false ? 'read-only' : 'ok';
    } catch (err) {
      githubStatus = err.status === 401 ? 'rejected' : err.status === 403 || err.status === 404 ? 'no access' : 'unreachable';
    }
  }
  return json({ ready: !missing.length && githubStatus === 'ok', missing, github: githubStatus });
}
