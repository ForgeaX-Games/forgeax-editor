import type { NavHistoryAPI } from './hooks';

interface Props {
  nav: NavHistoryAPI;
  gameSlug: string;
}

export function CBNavigationBar({ nav, gameSlug }: Props) {
  const segments = nav.currentPath ? nav.currentPath.split('/').filter(Boolean) : [];

  return (
    <div className="cb-navigation-bar">
      <button
        className="cb-nav-btn"
        disabled={!nav.canGoBack}
        onClick={nav.goBack}
        title="Back"
      >◀</button>
      <button
        className="cb-nav-btn"
        disabled={!nav.canGoForward}
        onClick={nav.goForward}
        title="Forward"
      >▶</button>

      <div className="cb-breadcrumb">
        <button
          className="cb-crumb"
          onClick={() => nav.navigate('')}
        >
          {gameSlug || 'All'}
        </button>
        {segments.map((seg, i) => {
          const path = segments.slice(0, i + 1).join('/');
          return (
            <span key={path}>
              <span className="cb-crumb-sep">{'>'}</span>
              <button className="cb-crumb" onClick={() => nav.navigate(path)}>
                {seg}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
