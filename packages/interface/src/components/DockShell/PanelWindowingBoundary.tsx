import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n';
import { useShellStore } from '../../store';
import type { DetachedWindowCapability } from '../../lib/platform';
import { shouldShowDetachedPlaceholder } from './panelWindowing';

export function PanelWindowingBoundary({
  capability,
  children,
}: {
  capability?: DetachedWindowCapability;
  children: ReactNode;
}): ReactNode {
  const { t } = useTranslation();
  const floatingSurfaces = useShellStore((state) => state.floatingSurfaces);

  if (capability) {
    try {
      const target = capability.createTarget();
      if (
        target.dockBehavior === 'keep-anchor'
        && shouldShowDetachedPlaceholder(floatingSurfaces, target.surface)
      ) {
        return (
          <div className="surface-placeholder">
            <div className="surface-placeholder-title">
              {t('dockShell.detachedWindowPlaceholder')}
            </div>
          </div>
        );
      }
    } catch {
      // Invalid windowing declarations must not suppress the ordinary panel body.
    }
  }

  return children;
}
