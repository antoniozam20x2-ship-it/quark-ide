import { useEffect } from 'react';
import QuarkAgent from '../components/Agent/QuarkAgent';
import { PROJECTS } from '../App';

interface AgentPageProps {
  onOpenEditor: (showPreview?: boolean) => void;
  initialPrompt?: string;
  onPromptConsumed?: () => void;
}

export default function AgentPage({ onOpenEditor, initialPrompt, onPromptConsumed }: AgentPageProps) {
  useEffect(() => {
    if (initialPrompt) onPromptConsumed?.();
  }, [initialPrompt]);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <QuarkAgent
        activeProject={PROJECTS[0]}
        onApplyToEditor={() => {}}
        onShowPreview={() => onOpenEditor(true)}
        initialPrompt={initialPrompt}
      />
    </div>
  );
}
