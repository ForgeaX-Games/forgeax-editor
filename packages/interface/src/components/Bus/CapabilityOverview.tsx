import { useEffect, useMemo, useState } from 'react';
import {
  listSharedCapabilities,
  type SharedCapabilityInfo,
  type SharedCapabilityKind,
} from '../../lib/extension-api';

const KIND_ORDER: SharedCapabilityKind[] = ['skill', 'command', 'mcp', 'extension', 'memory', 'tool'];
const KIND_LABELS: Record<SharedCapabilityKind, string> = {
  skill: 'Skill',
  command: 'Command',
  mcp: 'MCP',
  extension: 'Plugin',
  memory: 'Memory',
  tool: 'Tool',
};

function originLabel(capability: SharedCapabilityInfo): string {
  return `${capability.origin}/${capability.trustTier}`;
}

export function CapabilityOverview({ refreshKey }: { refreshKey: number }) {
  const [capabilities, setCapabilities] = useState<SharedCapabilityInfo[]>([]);
  const [generation, setGeneration] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listSharedCapabilities()
      .then((result) => {
        if (cancelled) return;
        setCapabilities(result.capabilities);
        setGeneration(result.generation);
        setIssues(result.issues);
      })
      .catch(() => {
        if (!cancelled) {
          setCapabilities([]);
          setIssues(['Capability snapshot unavailable']);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const counts = useMemo(() => {
    const result = new Map<SharedCapabilityKind, number>();
    for (const kind of KIND_ORDER) result.set(kind, 0);
    for (const capability of capabilities) {
      result.set(capability.kind, (result.get(capability.kind) ?? 0) + 1);
    }
    return result;
  }, [capabilities]);

  return (
    <section className="ba-capability-overview" aria-label="Shared capabilities">
      <div className="ba-capability-head">
        <span className="ba-capability-dot" aria-hidden />
        <span className="ba-capability-label">Shared capabilities</span>
        <span className="ba-capability-count">{capabilities.length}</span>
        <span className="ba-capability-generation">generation {generation}</span>
      </div>
      <div className="ba-capability-kinds" role="list" aria-label="Capability kinds">
        {KIND_ORDER.map((kind) => (
          <span key={kind} className={`ba-capability-kind ba-capability-kind-${kind}`} role="listitem">
            <span>{KIND_LABELS[kind]}</span>
            <strong>{counts.get(kind) ?? 0}</strong>
          </span>
        ))}
      </div>
      {capabilities.length > 0 && (
        <div className="ba-capability-list">
          {capabilities.map((capability) => (
            <div className="ba-capability-row" key={capability.capabilityId}>
              <span className={`ba-capability-type ba-capability-kind-${capability.kind}`}>
                {KIND_LABELS[capability.kind]}
              </span>
              <code className="ba-capability-id">{capability.localId}</code>
              <span className="ba-capability-extension">{capability.extensionId}</span>
              <span className="ba-capability-version">v{capability.extensionVersion}</span>
              <span className={`ba-capability-state is-${capability.lifecycle.state}`}>
                {capability.lifecycle.state}
              </span>
              <span className="ba-capability-origin">{originLabel(capability)}</span>
              {capability.lifecycle.requiresRestart && (
                <span className="ba-capability-restart">restart</span>
              )}
            </div>
          ))}
        </div>
      )}
      {issues.length > 0 && (
        <div className="ba-capability-issues" role="status">
          {issues.length} capability issue{issues.length === 1 ? '' : 's'} — open the snapshot API for details
        </div>
      )}
    </section>
  );
}
