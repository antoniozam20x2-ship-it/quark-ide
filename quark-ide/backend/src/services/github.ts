import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const OWNER = process.env.GITHUB_OWNER!;
const DEFAULT_REPO   = process.env.GITHUB_REPO!;
const DEFAULT_BRANCH = process.env.GITHUB_BRANCH ?? 'main';

export async function getFileTree(
  repo?: string,
  branch?: string,
): Promise<{ path: string; type: string; sha: string }[]> {
  const r = repo   ?? process.env.GITHUB_REPO   ?? DEFAULT_REPO;
  const b = branch ?? process.env.GITHUB_BRANCH ?? DEFAULT_BRANCH;

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

export async function getFileContent(path: string, repo?: string): Promise<string> {
  const r = repo ?? process.env.GITHUB_REPO ?? DEFAULT_REPO;
  const b = process.env.GITHUB_BRANCH ?? DEFAULT_BRANCH;

  const { data } = await octokit.repos.getContent({
    owner: OWNER, repo: r, path, ref: b,
  });

  if (Array.isArray(data) || data.type !== 'file') {
    throw new Error(`${path} is not a file`);
  }

  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function createOrUpdateFile(
  path: string,
  content: string,
  message: string,
  repo?: string,
): Promise<void> {
  const r = repo ?? process.env.GITHUB_REPO ?? DEFAULT_REPO;
  const b = process.env.GITHUB_BRANCH ?? DEFAULT_BRANCH;

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

export async function deleteFile(path: string, message: string): Promise<void> {
  const r = process.env.GITHUB_REPO   ?? DEFAULT_REPO;
  const b = process.env.GITHUB_BRANCH ?? DEFAULT_BRANCH;

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
  repo: string = DEFAULT_REPO,
  branch: string = DEFAULT_BRANCH,
): Promise<string> {
  // 1. SHA del branch actual
  const ref = await octokit.git.getRef({ owner: OWNER, repo, ref: `heads/${branch}` });
  const latestCommitSha = ref.data.object.sha;

  // 2. SHA del tree base
  const commit = await octokit.git.getCommit({ owner: OWNER, repo, commit_sha: latestCommitSha });
  const baseTreeSha = commit.data.tree.sha;

  // 3. Crear blobs en paralelo
  const blobs = await Promise.all(
    files.map((f) =>
      octokit.git.createBlob({
        owner: OWNER, repo,
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      }),
    ),
  );

  // 4. Crear nuevo tree
  const tree = await octokit.git.createTree({
    owner: OWNER, repo,
    base_tree: baseTreeSha,
    tree: files.map((f, i) => ({
      path: f.path,
      mode: '100644' as const,
      type: 'blob'  as const,
      sha:  blobs[i].data.sha,
    })),
  });

  // 5. Crear commit
  const newCommit = await octokit.git.createCommit({
    owner: OWNER, repo,
    message,
    tree:    tree.data.sha,
    parents: [latestCommitSha],
  });

  // 6. Actualizar branch ref
  await octokit.git.updateRef({
    owner: OWNER, repo,
    ref: `heads/${branch}`,
    sha: newCommit.data.sha,
  });

  return newCommit.data.sha;
}
