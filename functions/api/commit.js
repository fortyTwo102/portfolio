// Save a set of changes as one commit. Saves skip the Cloudflare build; Publish (publish.js) triggers it.
import { json, error, requireAdmin, github, githubError, commitAuthor, allowedPath, missingSettings, GITHUB_SETTINGS } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  const problem = missingSettings(env, GITHUB_SETTINGS);
  if (problem) return error(500, problem);

  let body;
  try { body = await request.json(); } catch { return error(400, 'The save request was malformed.'); }
  const changes = Array.isArray(body.files) ? body.files : [];
  if (!changes.length || changes.length > 300) return error(400, 'There was nothing to save.');

  const tree = [];
  for (const c of changes) {
    if (!allowedPath(c.path)) return error(400, `The admin view can't write to "${c.path}".`);
    if (c.delete) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null });
    else if (typeof c.content === 'string') tree.push({ path: c.path, mode: '100644', type: 'blob', content: c.content });
    else if (typeof c.sha === 'string' && /^[0-9a-f]{40}$/.test(c.sha)) tree.push({ path: c.path, mode: '100644', type: 'blob', sha: c.sha });
    else return error(400, `No content was sent for "${c.path}".`);
  }

  const message = String(body.message || 'Update content').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const gh = github(env);
  try {
    const head = await gh.head();
    if (body.base && body.base !== head) {
      return error(409, 'Someone else saved changes since you loaded the admin view. Reload to get the latest version, then make your change again.');
    }
    const baseTree = await gh.treeOf(head);
    const newTree = await gh.createTree(baseTree, tree);
    const skip = body.publish ? '' : '[CF-Pages-Skip] ';
    const commit = await gh.createCommit(`${skip}${message}\n\nSaved in the admin view.`, newTree.sha, [head], commitAuthor(env));
    await gh.updateRef(commit.sha);
    return json({ head: commit.sha });
  } catch (err) {
    return githubError(err);
  }
}
