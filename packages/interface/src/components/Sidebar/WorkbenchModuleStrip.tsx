import { useTranslation } from '@/i18n';
import { iconForWorkbenchModule } from '../../lib/workbench-module-icons';
import type { BusEntry } from './sidebar-types';

type Props = {
  entries: BusEntry[];
  activeTabId: string;
  onSelect: (tabId: string) => void;
};

function shortenLabel(label: string): string {
  const s = label.trim();
  if (s.length <= 6) return s;
  return s.replace(/\s*\/\s*.*/, '').slice(0, 6);
}

/** Preview wb-module-strip — bus workbench plugins in 6-column grid. */
export function WorkbenchModuleStrip({ entries, activeTabId, onSelect }: Props) {
  const { t } = useTranslation();
  if (!entries || entries.length === 0) {
    return (
      <div className="wb-module-strip wb-module-strip--empty" role="listbox" aria-label={t('workbenchModuleStrip.ariaLabel')}>
        <span className="wb-module-strip__empty">{t('workbenchModuleStrip.empty')}</span>
      </div>
    );
  }
  return (
    <div className="wb-module-strip" role="listbox" aria-label={t('workbenchModuleStrip.ariaLabel')}>
      {entries.map((e) => {
        const active = e.id === activeTabId;
        const Icon = iconForWorkbenchModule({
          workbenchId: e.id,
          label: e.label,
          extensionId: e.manifest.id,
        });
        return (
          <button
            key={e.id}
            type="button"
            role="option"
            aria-selected={active}
            title={e.label}
            className={`wb-module-tile pressable${active ? ' active glow-accent' : ''}`}
            onClick={() => onSelect(e.id)}
          >
            <span className="wb-module-tile-icon" aria-hidden>
              <Icon size={20} strokeWidth={1.8} />
            </span>
            <span className="wb-module-tile-label">{shortenLabel(e.label)}</span>
          </button>
        );
      })}
    </div>
  );
}
