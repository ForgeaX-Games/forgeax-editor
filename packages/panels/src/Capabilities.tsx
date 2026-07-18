import { listComponentSchemas } from '@forgeax/editor-core';

// Capabilities panel — the component schema registry, the SAME source the
// Inspector reflects into widgets AND the AI bridge reflects into
// getComponentSchema. Showing it makes the editor's vocabulary legible: every
// component + field a human or AI can author. Read-only.
export function CapabilitiesPanel() {
  const schemas = listComponentSchemas();
  return (
    <div className="panel" data-testid="panel-capabilities">
      <h3>Capabilities</h3>
      <div className="cap-list" data-testid="cap-list">
        {schemas.map((cs) => (
          <div className="cap-comp" key={cs.name} data-testid={`cap-${cs.name}`}>
            <div className="cap-name">{cs.name}</div>
            <div className="cap-fields">
              {cs.fields.map((f) => (
                <span className="cap-field" key={f.key} title={f.tooltip ?? ''}>
                  {f.key}<span className="cap-type">:{f.type}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
