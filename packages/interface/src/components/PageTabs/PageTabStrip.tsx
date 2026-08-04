import { useSyncExternalStore, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { useHost } from '../../core/app-shell';

export function PageTabStrip(): ReactElement | null {
  const host = useHost();
  const snapshot = useSyncExternalStore(host.pages.subscribe, host.pages.getSnapshot, host.pages.getSnapshot);
  if (snapshot.instances.length === 0) return null;

  return (
    <div className="page-tab-strip" data-fx-slot="PageTabs" role="tablist" aria-label="Open pages">
      {snapshot.instances.map((page) => {
        const resolved = host.pageRegistry.get(page.typeId);
        const title = page.resource?.displayPath?.split('/').at(-1)
          ?? page.resource?.uri.split('/').at(-1)
          ?? resolved?.definition.title
          ?? page.typeId;
        const active = snapshot.activeKey === page.encodedKey;
        return (
          <div className="page-tab" data-active={active ? '1' : undefined} key={page.encodedKey}>
            <button
              className="page-tab__label"
              role="tab"
              aria-selected={active}
              onClick={() => void host.pages.focus(page.key)}
            >
              {title}
            </button>
            {page.closable && (
              <button
                className="page-tab__close"
                aria-label={`Close ${title}`}
                onClick={() => void host.pages.close(page.key)}
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
