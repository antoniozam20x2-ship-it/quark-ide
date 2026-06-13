import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;
const BRANCH = process.env.GITHUB_BRANCH ?? 'main';

export async function getFileTree(): Promise<{ path: string; type: string; sha: string }[]> {
  const { data: ref } = await octokit.git.getRef({
    owner: OWNER, repo: REPO,
    ref: `heads/${BRANCH}`,
  });
  const treeSha = ref.object.sha;

  const { data: commit } = await octokit.git.getCommit({
    owner: OWNER, repo: REPO, commit_sha: treeSha,
  });

  const { data: tree } = await octokit.git.getTree({
    owner: OWNER, repo: REPO,
    tree_sha: commit.tree.sha,
    recursive: '1',
  });

  return (tree.tree ?? [])
    .filter((item) => item.path && item.type && item.sha)
    .map((item) => ({ path: item.path!, type: item.type!, sha: item.sha! }));
}

export async function getFileContent(path: string): Promise<string> {
  const { data } = await octokit.repos.getContent({
    owner: OWNER, repo: REPO, path, ref: BRANCH,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function createOrUpdateFile(
  path: string,
  content: string,
  message: string
): Promise<void> {
  let sha: string | undefined;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER, repo: REPO, path, ref: BRANCH,
    });
    if (!Array.isArray(data) && data.type === 'file') sha = data.sha;
  } catch {
    // file does not exist yet — create it
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path,
    message,
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: BRANCH,
    ...(sha ? { sha } : {}),
  });
}

export async function deleteFile(path: string, message: string): Promise<void> {
  const { data } = await octokit.repos.getContent({
    owner: OWNER, repo: REPO, path, ref: BRANCH,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }

  await octokit.repos.deleteFile({
    owner: OWNER, repo: REPO, path,
    message,
    sha: data.sha,
    branch: BRANCH,
  });
}
