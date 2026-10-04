// Read every content file from the repository in one GitHub GraphQL call.
import { json, error, requireAdmin, github, githubError, missingSettings, GITHUB_SETTINGS } from '../../lib/server.js';

const QUERY = `query($owner: String!, $name: String!, $expr: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { oid } }
    object(expression: $expr) {
      ... on Tree { entries { name type object {
        ... on Blob { text isBinary }
        ... on Tree { entries { name type object { ... on Blob { text isBinary } } } }
      } } }
    }
  }
}`;

export async function onRequestGet({ request, env }) {
  const { response } = await requireAdmin(request, env);
  if (response) return response;
  const problem = missingSettings(env, GITHUB_SETTINGS);
  if (problem) return error(500, problem);

  const gh = github(env);
  const [owner, name] = gh.repo.split('/');
  let data;
  try {
    data = await gh.graphql(QUERY, { owner, name, expr: `${gh.branch}:content`, ref: `refs/heads/${gh.branch}` });
  } catch (err) {
    return githubError(err);
  }
  if (data.errors && data.errors.length) return error(502, `GitHub couldn't list the content: ${data.errors[0].message}`);
  const repo = data.data && data.data.repository;
  if (!repo || !repo.ref) return error(502, `The repository or branch "${gh.branch}" wasn't found. Check GITHUB_REPO and GITHUB_BRANCH.`);

  const files = {};
  const walk = (entries, prefix) => {
    for (const e of entries || []) {
      const path = `${prefix}/${e.name}`;
      if (e.type === 'tree' && e.object && e.object.entries) walk(e.object.entries, path);
      else if (e.type === 'blob' && e.object && !e.object.isBinary && typeof e.object.text === 'string') files[path] = e.object.text;
    }
  };
  walk(repo.object && repo.object.entries, 'content');
  return json({ head: repo.ref.target.oid, files });
}
