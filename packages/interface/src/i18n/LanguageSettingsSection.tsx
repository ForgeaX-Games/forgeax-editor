/**
 * Language settings section body — rendered inside the SettingsPanel "System"
 * group. Lets the user switch the interface language at runtime. English is the
 * source of truth; every other language is a translation overlay.
 *
 * Registered from SectionsRegister.tsx via useSettingsSection({ id: 'language' }).
 */

import { Globe } from 'lucide-react';
import { Section } from '../components/TopBar/SettingsDrawer';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  SUPPORTED_LOCALES,
  useTranslation,
  type Locale,
} from './index';

export function LanguageSection() {
  const { t, i18n } = useTranslation();

  return (
    <Section icon={<Globe size={14} />} title={t('settings.language.label')} hint={t('settings.language.description')}>
      <Select
        value={i18n.language}
        onValueChange={(v) => i18n.changeLanguage(v as Locale)}
      >
        <SelectTrigger
          className="w-[220px]"
          aria-label={t('settings.language.selectAria')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SUPPORTED_LOCALES.map((l) => (
            <SelectItem key={l.code} value={l.code}>
              {l.nativeLabel}
              {l.nativeLabel !== l.label ? ` · ${l.label}` : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Section>
  );
}
