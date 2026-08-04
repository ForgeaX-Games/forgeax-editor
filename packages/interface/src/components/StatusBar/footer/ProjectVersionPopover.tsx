/**
 * ProjectVersionPopover — the leftmost footer entry (demo `data-sb-pop=
 * "version"`). A status-bar chip showing the current editor/Studio version
 * that, on click, opens an upward card listing the version history.
 *
 * REAL data:
 *   - current version + 说明: GET /api/version → { version, branch, sha, ... }
 *     (the editor's own v0.M.D.N build, NOT a game's tags).
 *   - version list: GET /api/version/tags → the studio repo's `vN` git tags.
 *
 * Same demo layout (当前版本 + 版本说明 + version rows); pure display.
 * Lives in interface, auto-registered by chrome-statusbar.
 */
import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { StripPopover } from '../StripPopover';
import type { StatusItemContribution } from '../../../core/panels';
import './footer.css';

interface VersionInfo {
  version: string;
  sha: string;
  date: string;
  totalCommits: number;
  branch: string;
}

interface VersionTag {
  tag: string;
  date: string;
  message: string;
}

const FALLBACK: VersionInfo = { version: 'v0.?.?.?', sha: '?', date: '?', totalCommits: 0, branch: '?' };

export function ProjectVersionChip() {
  const [info, setInfo] = useState<VersionInfo>(FALLBACK);
  const [tags, setTags] = useState<readonly VersionTag[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch('/api/version')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setInfo(d as VersionInfo);
        })
        .catch(() => {});
      fetch('/api/version/tags')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setTags((d as { tags?: VersionTag[] }).tags ?? []);
        })
        .catch(() => {});
    };
    refresh();
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
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

  return (
    <StripPopover
      icon="Layers"
      label={info.version}
      tooltip="项目版本"
      title={
        <>
          <Layers size={13} />
          项目版本
        </>
      }
    >
      <div className="fx-pop-sec">
        <div className="fx-kv">
          <span>当前版本</span>
          <b>{info.version}</b>
        </div>
        <div className="fx-kv">
          <span>版本说明</span>
          <b>
            {info.branch} · {info.sha}
          </b>
        </div>
      </div>
      <div className="fx-pop-div" />
      {tags.length === 0 ? (
        <div className="fx-empty">暂无版本 tag</div>
      ) : (
        tags.map((v) => (
          <div key={v.tag} className="fx-ver">
            <span className="ver">{v.tag}</span>
            <span className="lbl">{v.message}</span>
            <span className="t">{v.date}</span>
          </div>
        ))
      )}
    </StripPopover>
  );
}

export const projectVersionStatusItem: StatusItemContribution = {
  kind: 'status-item',
  id: 'project-version',
  location: 'statusbar.left',
  priority: 1000,
  item: { type: 'custom', render: () => <ProjectVersionChip /> },
};
