import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';

interface QuarkMarkdownProps {
  children: string;
  onApplyCode?: (code: string) => void;
  allowApply?: boolean;
  fontSize?: number;
}

export default function QuarkMarkdown({
  children,
  onApplyCode,
  allowApply = true,
  fontSize = 13,
}: QuarkMarkdownProps) {
  const components: Components = {
    // Strip the <pre> wrapper — our code component renders the full block
    pre: ({ children: preChildren }) => <>{preChildren}</>,

    code: ({ className, children }) => {
      const match = /language-(\w+)/.exec(className || '');
      const codeStr = String(children).trimEnd();

      if (!match) {
        // Inline code — no language class
        return (
          <code style={{
            background: '#1e1e3f',
            color: '#00ff88',
            fontSize: fontSize - 1,
            padding: '1px 5px',
            borderRadius: 3,
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            {children}
          </code>
        );
      }

      // Fenced code block
      const lang = match[1];
      return (
        <div style={{ margin: '8px 0', width: '100%' }}>
          <div style={{
            background: '#08080f',
            border: '1px solid #1e1e3f',
            borderRadius: 6,
            overflow: 'hidden',
          }}>
            {/* Header: lang label + action button */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '4px 12px',
              background: '#111127',
              borderBottom: '1px solid #1e1e3f',
            }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>{lang}</span>
              {onApplyCode ? (
                allowApply ? (
                  <button
                    className="quark-btn"
                    style={{ fontSize: 10, padding: '2px 8px' }}
                    onClick={() => onApplyCode(codeStr)}
                  >
                    ✦ Apply to editor
                  </button>
                ) : (
                  <span style={{ fontSize: 10, color: '#3a3a5c', fontFamily: 'JetBrains Mono, monospace' }}>
                    streaming…
                  </span>
                )
              ) : (
                <button
                  className="quark-btn"
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={() => navigator.clipboard?.writeText(codeStr)}
                >
                  copy
                </button>
              )}
            </div>

            {/* Code body */}
            <pre style={{
              margin: 0,
              padding: '12px',
              overflowX: 'auto',
              fontSize: 12,
              color: '#e2e8f0',
              fontFamily: 'JetBrains Mono, monospace',
              whiteSpace: 'pre',
            }}>
              <code>{codeStr}</code>
            </pre>
          </div>
        </div>
      );
    },

    p: ({ children: pChildren }) => (
      <p style={{
        color: '#e2e8f0',
        fontSize,
        lineHeight: 1.65,
        margin: '0 0 8px',
        wordBreak: 'break-word',
        overflowWrap: 'break-word',
      }}>
        {pChildren}
      </p>
    ),

    h1: ({ children: hChildren }) => (
      <h1 style={{ color: '#00ff88', fontSize: fontSize + 4, fontWeight: 700, margin: '14px 0 6px', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em' }}>
        {hChildren}
      </h1>
    ),
    h2: ({ children: hChildren }) => (
      <h2 style={{ color: '#00ff88', fontSize: fontSize + 2, fontWeight: 700, margin: '12px 0 6px', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em' }}>
        {hChildren}
      </h2>
    ),
    h3: ({ children: hChildren }) => (
      <h3 style={{ color: '#00ff88', fontSize: fontSize + 1, fontWeight: 700, margin: '10px 0 4px', fontFamily: 'JetBrains Mono, monospace' }}>
        {hChildren}
      </h3>
    ),
    h4: ({ children: hChildren }) => (
      <h4 style={{ color: '#e2e8f0', fontSize, fontWeight: 700, margin: '8px 0 4px' }}>
        {hChildren}
      </h4>
    ),

    strong: ({ children: sChildren }) => (
      <strong style={{ color: '#e2e8f0', fontWeight: 700 }}>{sChildren}</strong>
    ),

    em: ({ children: eChildren }) => (
      <em style={{ color: '#a0a0b8' }}>{eChildren}</em>
    ),

    ul: ({ children: ulChildren }) => (
      <ul style={{ paddingLeft: 20, margin: '4px 0 8px', color: '#e2e8f0' }}>{ulChildren}</ul>
    ),

    ol: ({ children: olChildren }) => (
      <ol style={{ paddingLeft: 20, margin: '4px 0 8px', color: '#e2e8f0' }}>{olChildren}</ol>
    ),

    li: ({ children: liChildren }) => (
      <li style={{ color: '#e2e8f0', fontSize, lineHeight: 1.65, marginBottom: 2, wordBreak: 'break-word' }}>
        {liChildren}
      </li>
    ),

    blockquote: ({ children: bqChildren }) => (
      <blockquote style={{
        borderLeft: '3px solid #1e1e3f',
        paddingLeft: 12,
        color: '#6b7280',
        margin: '6px 0',
        fontStyle: 'italic',
      }}>
        {bqChildren}
      </blockquote>
    ),

    hr: () => (
      <hr style={{ border: 'none', borderTop: '1px solid #1e1e3f', margin: '12px 0' }} />
    ),

    a: ({ href, children: aChildren }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#00ff88', textDecoration: 'underline', textDecorationColor: 'rgba(0,255,136,0.4)' }}
      >
        {aChildren}
      </a>
    ),
  };

  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <ReactMarkdown components={components}>{children}</ReactMarkdown>
    </div>
  );
}
