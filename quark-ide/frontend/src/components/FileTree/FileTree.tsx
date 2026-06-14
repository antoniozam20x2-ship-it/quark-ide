import { useState, useEffect } from 'react';

const API_BASE = (import.meta.env.VITE_API_URL ?? window.location.origin).replace(/\/$/, '');

interface GitItem {
  path: string;
  type: string;
  sha: string;
}

interface TreeNode {
  name: string;
  path: string;
  type: 'blob' | 'tree';
  children: TreeNode[];
}

interface Props {
  onFileSelect: (path: string, content: string) => void;
  activeRepo?: string;
}

function buildTree(items: GitItem[]): TreeNode[] {
  const nodeMap: Record<string, TreeNode> = {};

  for (const item of items) {
    nodeMap[item.path] = {
      name: item.path.split('/').pop()!,
      path: item.path,
      type: item.type as 'blob' | 'tree',
      children: [],
    };
  }

  const roots: TreeNode[] = [];
  for (const item of items) {
    const parts = item.path.split('/');
    if (parts.length === 1) {
      roots.push(nodeMap[item.path]);
    } else {
      const parentPath = parts.slice(0, -1).join('/');
      if (nodeMap[parentPath]) {
        nodeMap[parentPath].children.push(nodeMap[item.path]);
      } else {
        roots.push(nodeMap[item.path]);
      }
    }
  }

  function sortNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => ({ ...n, children: sortNodes(n.children) }));
  }

  return sortNodes(roots);
}

function TreeNodeRow({
  node,
  depth,
  activePath,
  loading,
  onFileClick,
}: {
  node: TreeNode;
  depth: number;
  activePath: string;
  loading: string;
  onFileClick: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 2);
  const isActive = node.path === activePath;
  const isLoading = node.path === loading;
  const isFolder = node.type === 'tree';

  return (
    <>
      <button
        onClick={() => isFolder ? setOpen((o) => !o) : onFileClick(node.path)}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          background: isActive ? 'rgba(0,255,136,0.08)' : 'transparent',
          border: 'none',
          borderLeft: `2px solid ${isActive ? '#00ff88' : 'transparent'}`,
          padding: `5px 8px 5px ${10 + depth * 14}px`,
          textAlign: 'left',
          color: isLoading ? '#00ff88' : isActive ? '#e2e8f0' : isFolder ? '#a0aec0' : '#6b7280',
          fontSize: 12,
          fontFamily: 'JetBrains Mono, monospace',
          cursor: 'pointer',
          gap: 6,
          transition: 'all 0.1s',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span style={{ flexShrink: 0, fontSize: 11 }}>
          {isFolder ? (open ? '📂' : '📁') : '📄'}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
          {isLoading ? '⟳ ' : ''}{node.name}
        </span>
      </button>
      {isFolder && open && node.children.map((child) => (
        <TreeNodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          loading={loading}
          onFileClick={onFileClick}
        />
      ))}
    </>
  );
}

export default function GitHubFileTree({ onFileSelect, activeRepo }: Props) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [activePath, setActivePath] = useState('');
  const [loadingPath, setLoadingPath] = useState('');
  const [error, setError] = useState('');

  function fetchFileTree() {
    setStatus('loading');
    setTree([]);
    const repoParam = activeRepo ? `?repo=${encodeURIComponent(activeRepo)}` : '';
    fetch(`${API_BASE}/github/tree${repoParam}`)
      .then((r) => r.json())
      .then((items: GitItem[]) => {
        setTree(buildTree(items));
        setStatus('ready');
      })
      .catch(() => {
        setError('Could not load repo. Check GITHUB_TOKEN.');
        setStatus('error');
      });
  }

  useEffect(() => {
    fetchFileTree();
  }, []);

  useEffect(() => {
    if (activeRepo === undefined) return;
    fetchFileTree();
  }, [activeRepo]);

  async function handleFileClick(path: string) {
    if (loadingPath) return;
    setLoadingPath(path);
    try {
      const res = await fetch(`${API_BASE}/github/file?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setActivePath(path);
      onFileSelect(path, data.content);
    } catch {
      setError(`Failed to load ${path}`);
    } finally {
      setLoadingPath('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Header */}
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid #1e1e3f',
        borderTop: '1px solid #1e1e3f',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
        background: '#0d0d1a',
      }}>
        <span style={{
          color: '#6b7280',
          fontSize: 11,
          letterSpacing: '0.08em',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          GITHUB REPO
        </span>
        {status === 'loading' && (
          <span style={{ color: '#00ff88', fontSize: 10 }}>loading…</span>
        )}
        {status === 'ready' && (
          <span style={{ color: '#3a3a5c', fontSize: 10 }}>{tree.length} items</span>
        )}
      </div>

      {/* Tree body */}
      <div style={{ overflowY: 'auto', flex: 1, padding: '4px 0' }}>
        {status === 'error' && (
          <div style={{
            padding: '8px 12px',
            color: '#ff4444',
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            ⚠ {error}
          </div>
        )}
        {status === 'ready' && tree.map((node) => (
          <TreeNodeRow
            key={node.path}
            node={node}
            depth={0}
            activePath={activePath}
            loading={loadingPath}
            onFileClick={handleFileClick}
          />
        ))}
      </div>
    </div>
  );
}
