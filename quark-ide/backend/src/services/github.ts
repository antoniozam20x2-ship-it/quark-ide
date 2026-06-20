import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER          = process.env.GITHUB_OWNER!;
const DEFAULT_BRANCH = process.env.GITHUB_BRANCH ?? 'main';

function requireRepo(repo?: string): string {
  if (!repo) throw new Error('repo is required — must be provided in the request body');
  return repo;
}

export async function getFileTree(
  repo?: string,
  branch?: string,
): Promise<{ path: string; type: string; sha: string }[]> {
  const r = requireRepo(repo);
  const b = branch ?? DEFAULT_BRANCH;

  const { data: ref } = await octokit.git.getRef({
    owner: OWNER, repo: r,
    ref: `heads/${b}`,
  });
  const treeSha = ref.object.sha;

  const { data: commit } = await octokit.git.getCommit({
    owner: OWNER, repo: r, commit_sha: treeSha,
  });

  const { data: tree } = await octokit.git.getTree({
    owner: OWNER, repo: r,
    tree_sha: commit.tree.sha,
    recursive: '1',
  });

  return (tree.tree ?? [])
    .filter((item) => item.path && item.type && item.sha)
    .map((item) => ({ path: item.path!, type: item.type!, sha: item.sha! }));
}

export async function getFileContent(path: string, repo?: string, branch?: string): Promise<string> {
  const r = requireRepo(repo);
  const b = branch ?? DEFAULT_BRANCH;

  const { data } = await octokit.repos.getContent({
    owner: OWNER, repo: r, path, ref: b,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function searchCodeInRepo(
  query: string,
  repo?: string,
): Promise<{ path: string }[]> {
  const r = requireRepo(repo);
  try {
    const { data } = await octokit.search.code({
      q: `${query}+repo:${OWNER}/${r}`,
    });
    return data.items.map((item) => ({ path: item.path }));
  } catch (err) {
    console.warn(`[github] searchCodeInRepo failed for "${query}":`, err instanceof Error ? err.message : err);
    return [];
  }
}

export async function createOrUpdateFile(
  path: string,
  content: string,
  message: string,
  repo?: string,
  branch?: string,
): Promise<void> {
  const r = requireRepo(repo);
  const b = branch ?? DEFAULT_BRANCH;

  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER, repo: r, path, ref: b,
    });
    if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
  } catch {
    // file does not exist yet — create it
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: r, path,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: b,
    ...(sha ? { sha } : {}),
  });
}

export async function deleteFile(path: string, message: string, repo?: string, branch?: string): Promise<void> {
  const r = requireRepo(repo);
  const b = branch ?? DEFAULT_BRANCH;

  const { data } = await octokit.repos.getContent({
    owner: OWNER, repo: r, path, ref: b,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }

  await octokit.repos.deleteFile({
    owner: OWNER, repo: r, path,
    message,
    sha: data.sha,
    branch: b,
  });
}

export async function commitMultipleFiles(
  files: { path: string; content: string }[],
  message: string,
  repo?: string,
  branch?: string,
): Promise<string> {
  const r = requireRepo(repo);
  const b = branch ?? DEFAULT_BRANCH;

  const ref = await octokit.git.getRef({ owner: OWNER, repo: r, ref: `heads/${b}` });
  const latestCommitSha = ref.data.object.sha;

  const commit = await octokit.git.getCommit({ owner: OWNER, repo: r, commit_sha: latestCommitSha });
  const baseTreeSha = commit.data.tree.sha;

  const blobs = await Promise.all(
    files.map((f) =>
      octokit.git.createBlob({
        owner: OWNER, repo: r,
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      }),
    ),
  );

  const tree = await octokit.git.createTree({
    owner: OWNER, repo: r,
    base_tree: baseTreeSha,
    tree: files.map((f, i) => ({
      path: f.path,
      mode: '100644' as const,
      type: 'blob'  as const,
      sha:  blobs[i].data.sha,
    })),
  });

  const newCommit = await octokit.git.createCommit({
    owner: OWNER, repo: r,
    message,
    tree:    tree.data.sha,
    parents: [latestCommitSha],
  });

  await octokit.git.updateRef({
    owner: OWNER, repo: r,
    ref: `heads/${b}`,
    sha: newCommit.data.sha,
  });

  return newCommit.data.sha;
}
