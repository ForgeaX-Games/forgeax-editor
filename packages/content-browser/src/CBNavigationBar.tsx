import {
  Breadcrumb,
  BreadcrumbButton,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
} from '@forgeax/editor-ui';
import { Fragment } from 'react';
import { useTranslation } from '@forgeax/editor-core/i18n';
import type { NavHistoryAPI } from './hooks';

interface Props {
  nav: NavHistoryAPI;
  gameSlug: string;
}

export function CBNavigationBar({ nav, gameSlug }: Props) {
  const { t } = useTranslation();
  const segments = nav.currentPath ? nav.currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="cb-navigation-bar">
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

      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            {segments.length === 0 ? (
              <BreadcrumbPage>{gameSlug || t('editor.contentBrowser.actions.all')}</BreadcrumbPage>
            ) : (
              <BreadcrumbButton size="sm" onClick={() => nav.navigate('')}>
                {gameSlug || t('editor.contentBrowser.actions.all')}
              </BreadcrumbButton>
            )}
          </BreadcrumbItem>
          {segments.map((seg, i) => {
            const path = segments.slice(0, i + 1).join('/');
            const isCurrent = i === segments.length - 1;
            return (
              <Fragment key={path}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isCurrent ? (
                    <BreadcrumbPage>{seg}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbButton size="sm" onClick={() => nav.navigate(path)}>
                      {seg}
                    </BreadcrumbButton>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
