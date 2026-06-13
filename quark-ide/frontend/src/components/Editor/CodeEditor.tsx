import Editor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

interface Props {
  value: string;
  language: string;
  onChange: (val: string) => void;
  onEditorReady?: (editor: editor.IStandaloneCodeEditor) => void;
}

const QUARK_THEME: editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'string', foreground: '00ff88' },
    { token: 'number', foreground: 'ffa500' },
    { token: 'type', foreground: '38bdf8' },
    { token: 'function', foreground: 'e2e8f0' },
    { token: 'variable', foreground: 'e2e8f0' },
  ],
  colors: {
    'editor.background': '#08080f',
    'editor.foreground': '#e2e8f0',
    'editor.lineHighlightBackground': '#0d0d1a',
    'editor.selectionBackground': '#1e1e3f',
    'editor.inactiveSelectionBackground': '#111127',
    'editorCursor.foreground': '#00ff88',
    'editorLineNumber.foreground': '#3a3a5c',
    'editorLineNumber.activeForeground': '#00ff88',
    'editorIndentGuide.background': '#1e1e3f',
    'editorIndentGuide.activeBackground': '#3a3a5c',
    'scrollbarSlider.background': '#1e1e3f',
    'scrollbarSlider.hoverBackground': '#00ff88',
    'scrollbarSlider.activeBackground': '#00ff88',
    'minimap.background': '#08080f',
    'editorGutter.background': '#08080f',
    'editor.widgetBorder': '#1e1e3f',
    'editorWidget.background': '#0d0d1a',
    'editorWidget.border': '#1e1e3f',
    'editorSuggestWidget.background': '#0d0d1a',
    'editorSuggestWidget.border': '#1e1e3f',
    'editorSuggestWidget.selectedBackground': '#111127',
  },
};

export default function CodeEditor({ value, language, onChange, onEditorReady }: Props) {
  function handleEditorMount(ed: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) {
    monaco.editor.defineTheme('quark-dark', QUARK_THEME);
    monaco.editor.setTheme('quark-dark');
    onEditorReady?.(ed);
  }

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="quark-dark"
      onChange={(val) => onChange(val ?? '')}
      onMount={handleEditorMount}
      options={{
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        lineHeight: 22,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        padding: { top: 16, bottom: 16 },
        renderLineHighlight: 'gutter',
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        tabSize: 2,
        bracketPairColorization: { enabled: true },
      }}
    />
  );
}
