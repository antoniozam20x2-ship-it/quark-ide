import QuarkAgent from '../components/Agent/QuarkAgent';
import { PROJECTS } from '../App';

interface AgentPageProps {
  onOpenEditor: () => void;
}

export default function AgentPage({ onOpenEditor: _onOpenEditor }: AgentPageProps) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <QuarkAgent
        activeProject={PROJECTS[0]}
        onApplyToEditor={() => {}}
        onShowPreview={() => {}}
      />
    </div>
  );
}
