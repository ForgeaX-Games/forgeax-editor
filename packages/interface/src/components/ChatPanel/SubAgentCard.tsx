import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/i18n';
import { useAppStore, type SubAgentRun } from '../../store';
import { ProviderBadgePill } from '../../lib/provider-badge';
import { ForgeText } from './message-parts/ForgeText';
import { ToolChipRow } from './message-parts/ToolChipRow';
import { KcCopyBtn } from './message-parts/KcCopyBtn';
import { buildInterleavedSegments, partitionToolCalls } from './message-parts/interleave';

const ROSTER: Record<string, { displayName: string; roleKey: string; color: string; emoji: string }> = {
  iori: { displayName: 'Iori', roleKey: 'subAgent.role.iori', color: 'var(--color-role-art)', emoji: '🏛️' },
  suzu: { displayName: 'Suzu', roleKey: 'subAgent.role.suzu', color: 'var(--color-role-orchestrator)', emoji: '📐' },
  kotone: { displayName: 'Kotone', roleKey: 'subAgent.role.kotone', color: 'var(--color-role-narrative)', emoji: '💬' },
  iro: { displayName: 'Iro', roleKey: 'subAgent.role.iro', color: 'var(--accent-mint)', emoji: '🎨' },
  tsumugi: { displayName: 'Tsumugi', roleKey: 'subAgent.role.tsumugi', color: 'var(--color-role-design)', emoji: '🛠️' },
  'cc-coder': { displayName: 'CC Coder', roleKey: 'subAgent.role.ccCoder', color: 'var(--color-role-orchestrator)', emoji: '🧠' },
};

function profileFor(emitterId: string): { displayName: string; roleKey: string; color: string; emoji: string } {
  const idLower = emitterId.toLowerCase();
  for (const key of Object.keys(ROSTER)) {
    if (idLower.includes(key)) return ROSTER[key];
  }
  return { displayName: emitterId, roleKey: 'subAgent.role.fallback', color: 'var(--prim-color-neutral-450)', emoji: '🤖' };
}

export function SubAgentCard({ run }: { run: SubAgentRun }) {
  // Default collapsed for completed runs (replay history + finished live)
  // so long chat scrollbacks aren't dominated by sub-agent walls of text.
  // Streaming sub-agents stay expanded so the user can watch progress.
  const { t } = useTranslation();
  const [open, setOpen] = useState(run.status === 'streaming');
  // P3.77 — mirror ForgeCard's provider-pill deep-link. SubAgentCard header
  // is also a <button>, so the pill renders as span-with-role inside.
  const setMode = useAppStore((s) => s.setMode);
  const openSettings = useAppStore((s) => s.openSettings);
  const setPendingBusExpandId = useAppStore((s) => s.setPendingBusExpandId);
  const setPendingBusKindFilter = useAppStore((s) => s.setPendingBusKindFilter);
  const onProviderBusDeepLink = (pluginId: string) => {
    setPendingBusKindFilter('cli-provider');
    setPendingBusExpandId(pluginId);
    openSettings('plugins');
  };
  const prof = profileFor(run.emitterId);
  const isStreaming = run.status === 'streaming';
  const text = run.text ?? '';
  const { ordered, orphans } = partitionToolCalls(run.toolCalls);
  // Interleave when the run is settled (not streaming) and has both text +
  // ordered tool chips with `at`. Mirrors ForgeCard's canInterleave gate.
  const canInterleave = !isStreaming && ordered.length > 0 && text.length > 0;
  return (
    <div className="sub-agent-card" style={{ borderLeftColor: prof.color }}>
      <button className="sac-header" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="sac-emoji">{prof.emoji}</span>
        <span className="sac-name" style={{ color: prof.color }}>{prof.displayName}</span>
        <span className="sac-role">{t(prof.roleKey)}</span>
        {run.providerId && (
          <ProviderBadgePill
            providerId={run.providerId}
            className="sac-provider"
            onBusDeepLink={onProviderBusDeepLink}
          />
        )}
        <span className={`sac-status ${run.status}`}>
          {isStreaming ? t('subAgent.status.running') : run.status === 'error' ? t('subAgent.status.error') : t('subAgent.status.done')}
        </span>
        <span className="sac-tools">{run.toolCalls.length} tool calls</span>
      </button>
      {open && (
        <div className="sac-body">
          {/* Copy button — only when sub has settled and produced text */}
          {!isStreaming && text.length > 0 && <KcCopyBtn text={text} size="sm" />}

          {/* Thinking — collapsed by default; markdown-rendered when expanded */}
          {run.thinking && (
            <details className="sac-thinking">
              <summary>thinking ({run.thinking.length} chars)</summary>
              <ForgeText text={run.thinking} animated={false} size="sm" />
            </details>
          )}

          {/* Body: interleaved when settled, sequential when streaming */}
          {canInterleave ? (
            <div className="kc-interleaved mp-sm">
              {buildInterleavedSegments(text, ordered).map((s, i) =>
                s.kind === 'text'
                  ? <ForgeText key={i} text={s.value} animated={false} size="sm" />
                  : <ToolChipRow key={`tc-${s.value.callId}`} tc={s.value} size="sm" />,
              )}
              {orphans.length > 0 && (
                <div className="kc-tools mp-sm">
                  {orphans.map((tc) => <ToolChipRow key={tc.callId} tc={tc} size="sm" />)}
                </div>
              )}
            </div>
          ) : (
            <>
              {text && <ForgeText text={text} animated={isStreaming} size="sm" />}
              {run.toolCalls.length > 0 && (
                <div className="kc-tools mp-sm">
                  {run.toolCalls.map((tc) => <ToolChipRow key={tc.callId} tc={tc} size="sm" />)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
