// standalone/DeleteGuardDialog — UI-layer confirmation for risky asset deletes
// (T4-3 / AC-C2). Mounted once in main.tsx on a dedicated React root so the
// keyboard router (which runs outside React) can request a human confirm via
// the delete-guard-bus. Keeps editor-core headless — no dialog in appliers.
import { useEffect, useState } from 'react';
import { subscribeDeleteGuard, resolveDeleteGuard, type DeleteGuardRequest } from './delete-guard-bus';

export function DeleteGuardDialog() {
  const [req, setReq] = useState<DeleteGuardRequest | null>(null);
  useEffect(() => subscribeDeleteGuard(setReq), []);
  if (!req) return null;

  const names = req.assets.map((a) => a.name || a.guid);
  const multi = req.assets.length > 1;

  return (
    <div
      data-testid="delete-guard-overlay"
      onClick={() => resolveDeleteGuard(false)}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        data-testid="delete-guard-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        style={{
          background: '#1e1e24', color: '#eee', borderRadius: 10,
          padding: 20, minWidth: 320, maxWidth: 420,
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>
          删除{multi ? ` ${req.assets.length} 个资产` : '资产'}？
        </h3>
        <p style={{ margin: '0 0 10px', fontSize: 13, opacity: 0.8 }}>
          这些资产将被永久删除（document 域 op，可撤销）。
        </p>
        <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 12, maxHeight: 120, overflow: 'auto' }}>
          {names.map((n, i) => (
            <li key={req.assets[i].guid}>{n}</li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            data-testid="delete-guard-cancel"
            onClick={() => resolveDeleteGuard(false)}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #555', background: 'transparent', color: '#eee', cursor: 'pointer' }}
          >
            取消
          </button>
          <button
            type="button"
            data-testid="delete-guard-confirm"
            onClick={() => resolveDeleteGuard(true)}
            style={{ padding: '6px 14px', borderRadius: 6, border: 'none', background: '#e5484d', color: '#fff', cursor: 'pointer' }}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
