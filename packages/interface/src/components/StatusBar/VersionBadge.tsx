/**
 * VersionBadge — forgeax-studio version chip pinned to bottom-left.
 *
 * Always-visible: priority=1000 anchors it as the leftmost chip of the
 * GlobalStatusBar (Blender-style bottom strip). Click → opens CHANGELOG
 * in a new tab (the repo file path the user can also `cat` locally).
 * Hover → tooltip shows commit sha + date + branch.
 *
 * Source: GET /api/version → { version, sha, date, totalCommits, branch }
 * Scheme:  v0.M.D.N
 *   0 — pre-1.0 epoch
 *   M.D — main 最新 commit 的月.日
 *   N — main 自第 1 天起累计 commit 数 (monotone)
 *
 * See:  packages/server/src/api/version.ts · scripts/version.sh · CHANGELOG.md
 */

import { useEffect, useState } from 'react';
import { useStatusBarItem } from './store';

interface VersionInfo {
  version: string;
  sha: string;
  date: string;
  totalCommits: number;
  branch: string;
}

const FALLBACK: VersionInfo = {
  version: 'v0.?.?.?',
  sha: '?',
  date: '?',
  totalCommits: 0,
  branch: '?',
};

export function VersionBadge() {
  const [info, setInfo] = useState<VersionInfo>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch('/api/version')
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data) setInfo(data as VersionInfo);
        })
        .catch(() => { /* leave previous value */ });
    };
    refresh();
    // Auto-update after commits: server-side fs.watch invalidates its cache
    // when .git/HEAD or refs/heads/main move; we just need to re-fetch on
    // signals that the user actually cares about the badge again.
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refresh);
    const poll = window.setInterval(refresh, 60_000);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refresh);
      window.clearInterval(poll);
    };
  }, []);

  // Permanent dirty marker if FORGEAX_VERSION env was set with "+dirty" suffix.
  const dirty = info.version.endsWith('+dirty');
  const display = dirty ? info.version : info.version;

  const chip = (
    <a
      className="sb-chip sb-version is-link"
      href="/CHANGELOG.md"
      target="_blank"
      rel="noreferrer"
      title={[
        `forgeax-studio · ${info.version}`,
        `commit ${info.sha} · ${info.date}`,
        `branch ${info.branch} · cumulative commits ${info.totalCommits}`,
        '',
        'Click → CHANGELOG.md',
      ].join('\n')}
      data-dirty={dirty || undefined}
      style={{
        color: dirty ? 'var(--prim-color-orange-300)' : 'var(--color-text-secondary)',
        textDecoration: 'none',
      }}
    >
      {display}
    </a>
  );

  useStatusBarItem({
    id: 'forgeax-version',
    slot: 'left',
    // Pin as the leftmost permanent chip — higher than FPS / slug / agent
    // (those are in the ~50-200 range). Carousel rotation can never replace it.
    priority: 1000,
    node: chip,
  });

  return null;
}
