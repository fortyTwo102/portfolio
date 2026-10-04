// Publishing = one commit without the skip flag, which makes Cloudflare Pages build and deploy the site.
import { json, error, requireAdmin, github, githubError, commitAuthor, missingSettings, GITHUB_SETTINGS } from '../../lib/server.js';

export async function onRequestPost({ request, env }) {
  const { session, response } = await requireAdmin(request, env);
  if (response) return response;
  const problem = missingSettings(env, GITHUB_SETTINGS);
  if (problem) return error(500, problem);

  const gh = github(env);
  try {
    const head = await gh.head();
    const tree = await gh.treeOf(head);
    const commit = await gh.createCommit(`Publish site\n\nPublished by ${session.name} in the admin view.`, tree, [head], commitAuthor(env, session.name));
    await gh.updateRef(commit.sha);
    return json({ head: commit.sha });
  } catch (err) {
    return githubError(err);
  }
}
