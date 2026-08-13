import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@forgeax/editor-ui';
import { ChevronRight, Folder } from 'lucide-react';
import { Fragment, useCallback, useState } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { NavHistoryAPI } from './hooks';
import { CONTENT_BROWSER_INTERACTION_SCOPE, contentBrowserInteractionAttrs } from './interaction-surface';

interface Props {
  nav: NavHistoryAPI;
  gameSlug: string;
  /** Every directory path in the game, used to populate the per-level dropdowns. */
  allDirs: string[];
  inline?: boolean;
}

/** Immediate subfolders of `path` (`''` = game root), sorted by name. */
function immediateChildren(allDirs: string[], path: string): { name: string; path: string }[] {
  const prefix = path ? `${path}/` : '';
  const depth = path ? path.split('/').length : 0;
  const out: { name: string; path: string }[] = [];
  for (const dir of allDirs) {
    if (path && dir === path) continue;
    if (!dir.startsWith(prefix)) continue;
    if (dir.split('/').length !== depth + 1) continue;
    out.push({ name: dir.split('/').pop() ?? dir, path: dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Sanitise a typed address into a game-relative path (`''` = root). */
function normalizePathInput(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

/**
 * The chevron sitting at the JUNCTION to the LEFT of a breadcrumb segment. In a
 * desktop file manager this chevron is a dropdown listing the subfolders of the
 * level on its left, so the user can hop sideways into a sibling without
 * stepping back up. There is no chevron after the last (current) segment.
 * Levels with no subfolders render a plain, non-interactive chevron.
 */
function LevelChevron({
  levelPath,
  activeNextSeg,
  allDirs,
  onNavigate,
  label,
}: {
  levelPath: string;
  activeNextSeg: string | null;
  allDirs: string[];
  onNavigate: (path: string) => void;
  label: string;
}) {
  const children = immediateChildren(allDirs, levelPath);
  if (children.length === 0) return <BreadcrumbSeparator />;
  return (
    <li role="presentation" className="cb-crumb-chevron">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="cb-crumb-chevron-btn no-motion-lift"
            aria-label={label}
            title={label}
            onClick={e => e.stopPropagation()}
          >
            <ChevronRight />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="cb-crumb-menu"
          interactionScope={CONTENT_BROWSER_INTERACTION_SCOPE}
        >
          {children.map(child => (
            <DropdownMenuItem
              key={child.path}
              size="sm"
              data-active={child.name === activeNextSeg ? '' : undefined}
              onClick={e => { e.stopPropagation(); onNavigate(child.path); }}
            >
              <Folder />
              {child.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function CBNavigationBar({ nav, gameSlug, allDirs, inline = false }: Props) {
  const { t } = useTranslation();
  const segments = nav.currentPath ? nav.currentPath.split('/').filter(Boolean) : [];
  const rootLabel = gameSlug || t('editor.contentBrowser.actions.all');

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const beginEdit = useCallback(() => {
    setDraft(nav.currentPath ?? '');
    setEditing(true);
  }, [nav.currentPath]);

  const commit = useCallback(() => {
    nav.navigate(normalizePathInput(draft));
    setEditing(false);
  }, [draft, nav]);

  const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditing(false);
    }
  }, [commit]);

  return (
    <div className={`cb-navigation-bar${inline ? ' cb-navigation-bar-inline' : ''}`}>
      <Button
        className="cb-nav-btn"
        disabled={!nav.canGoBack}
        size="sm"
        variant="chrome"
        onClick={nav.goBack}
        title={t('editor.contentBrowser.actions.back')}
      >◀</Button>
      <Button
        className="cb-nav-btn"
        disabled={!nav.canGoForward}
        size="sm"
        variant="chrome"
        onClick={nav.goForward}
        title={t('editor.contentBrowser.actions.forward')}
      >▶</Button>

      {/* Fixed-height slot: breadcrumb and input share the SAME height so the
          edit toggle never resizes the toolbar (no CB-wide reflow/flicker). */}
      <div className="cb-address-slot">
      {editing ? (
        <input
          {...contentBrowserInteractionAttrs}
          autoFocus
          spellCheck={false}
          className="cb-address-input"
          value={draft}
          placeholder={t('editor.contentBrowser.actions.editPathPlaceholder')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onInputKeyDown}
          onBlur={() => setEditing(false)}
          onFocus={e => e.currentTarget.select()}
        />
      ) : (
        // The whole address strip (including the blank remainder) is the "click
        // to type a path" hit target, like a desktop file manager. Segment and
        // chevron clicks stopPropagation so they run their own action instead.
        <div
          className="cb-address no-motion-lift"
          role="button"
          tabIndex={0}
          title={t('editor.contentBrowser.actions.editPath')}
          onClick={beginEdit}
        >
          <Breadcrumb className="cb-address-crumb">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbButton
                  size="sm"
                  className={segments.length === 0 ? 'cb-crumb-item cb-crumb-current' : 'cb-crumb-item'}
                  aria-current={segments.length === 0 ? 'page' : undefined}
                  onClick={e => { e.stopPropagation(); nav.navigate(''); }}
                >
                  {rootLabel}
                </BreadcrumbButton>
              </BreadcrumbItem>
              {segments.map((seg, i) => {
                const path = segments.slice(0, i + 1).join('/');
                const parentPath = segments.slice(0, i).join('/');
                const parentLabel = i === 0 ? rootLabel : (segments[i - 1] ?? rootLabel);
                const isCurrent = i === segments.length - 1;
                return (
                  <Fragment key={path}>
                    {/* Junction chevron: lists the subfolders of the level on its
                        left (parentPath), with the current branch highlighted. */}
                    <LevelChevron
                      levelPath={parentPath}
                      activeNextSeg={seg}
                      allDirs={allDirs}
                      onNavigate={nav.navigate}
                      label={t('editor.contentBrowser.actions.openSubfolders', { name: parentLabel })}
                    />
                    <BreadcrumbItem>
                      <BreadcrumbButton
                        size="sm"
                        className={isCurrent ? 'cb-crumb-item cb-crumb-current' : 'cb-crumb-item'}
                        aria-current={isCurrent ? 'page' : undefined}
                        onClick={e => { e.stopPropagation(); nav.navigate(path); }}
                      >
                        {seg}
                      </BreadcrumbButton>
                    </BreadcrumbItem>
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      )}
      </div>
    </div>
  );
}
