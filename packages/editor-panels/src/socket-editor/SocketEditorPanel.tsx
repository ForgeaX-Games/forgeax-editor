// @forgeax/editor-panels — Socket (绑点) editor panel.
//
// Productized form of the glbScene POC (开发文档 §★): pick a parent bone, tune
// the prop's bone-local position / rotation / scale with sliders, switch coord
// space / pivot (editing feel only), and export/import the SocketDoc JSON.
//
// State lives in editor-core (socket-store): the working SocketDoc + selection +
// coord/pivot modes. Edits flow through updateSocket/addSocket/removeSocket; the
// viewport subscribes via onSocketPreview for live (所见即所得) feedback.

import { useEffect, useState } from 'react';
import {
  addSocket,
  defaultSocket,
  exportSocketJson,
  getSocketDoc,
  importSocketJson,
  normalizeScale,
  removeSocket,
  requestView,
  setClipControl,
  setCoordSpace,
  setPivot,
  setSelectedSocketId,
  setSocketDoc,
  updateSocket,
  uniqueSocketId,
  useClipControl,
  useCoordSpace,
  usePivot,
  useSelectedSocketId,
  useSocketDocVersion,
  type SocketDef,
} from '@forgeax/editor-shared';

import './socket-editor.css';

type Vec3 = [number, number, number];

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step, onChange }: SliderRowProps) {
  const fixed = step >= 1 ? 0 : 3;
  return (
    <div className="se-row" data-testid={`se-row-${label}`}>
      <span className="se-ax">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <input
        type="number"
        className="se-num"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="se-val">{value.toFixed(fixed)}</span>
    </div>
  );
}

function Vec3Group({
  title,
  cls,
  axes,
  value,
  min,
  max,
  step,
  onChange,
}: {
  title: string;
  cls?: string;
  axes: [string, string, string];
  value: Vec3;
  min: number;
  max: number;
  step: number;
  onChange: (v: Vec3) => void;
}) {
  const set = (i: number, n: number): void => {
    const next: Vec3 = [value[0], value[1], value[2]];
    next[i] = n;
    onChange(next);
  };
  return (
    <div className="se-grp">
      <div className={`se-lbl ${cls ?? ''}`}>{title}</div>
      {axes.map((ax, i) => (
        <SliderRow key={ax} label={ax} value={value[i]!} min={min} max={max} step={step} onChange={(n) => set(i, n)} />
      ))}
    </div>
  );
}

// Animation transport for pose calibration (开发文档 §9). Controls the preview
// character's AnimationPlayer in the MAIN viewport — even when this panel is
// popped out — via editor-core's cross-window clip-control channel. A scrub
// auto-pauses + seeks; play/pause and speed leave the playhead untouched.
function ClipScrubber() {
  const clip = useClipControl();
  return (
    <div className="se-clip" data-testid="se-clip">
      <div className="se-lbl">动画预览（姿势标定）</div>
      <div className="se-clip-row">
        <button
          data-testid="se-clip-play"
          onClick={() => setClipControl({ paused: !clip.paused, applyPhase: false })}
        >
          {clip.paused ? '▶ 播放' : '⏸ 暂停'}
        </button>
      </div>
      <SliderRow
        label="进度"
        value={clip.phase}
        min={0}
        max={1}
        step={0.001}
        onChange={(n) => setClipControl({ phase: n, paused: true, applyPhase: true })}
      />
      <SliderRow
        label="速度"
        value={clip.speed}
        min={0}
        max={3}
        step={0.05}
        onChange={(n) => setClipControl({ speed: n, applyPhase: false })}
      />
    </div>
  );
}

export function SocketEditorPanel() {
  useSocketDocVersion();
  const doc = getSocketDoc();
  const selId = useSelectedSocketId();
  const coordSpace = useCoordSpace();
  const pivot = usePivot();
  const [io, setIo] = useState('');
  const [msg, setMsg] = useState('');

  const selected: SocketDef | undefined = doc.sockets.find((s) => s.id === selId);

  // Default-select the first socket once one exists.
  useEffect(() => {
    if (selId === null && doc.sockets.length > 0) setSelectedSocketId(doc.sockets[0]!.id);
  }, [selId, doc.sockets.length]);

  const onAdd = (): void => {
    const id = uniqueSocketId(doc.sockets, 'weapon');
    addSocket(defaultSocket(id, ''));
  };

  const onExport = (): void => {
    const text = exportSocketJson(doc);
    setIo(text);
    setMsg('');
  };

  const onCopy = (): void => {
    const text = exportSocketJson(doc);
    setIo(text);
    navigator.clipboard?.writeText(text).catch(() => {});
    setMsg('已复制');
    setTimeout(() => setMsg(''), 1200);
  };

  const onImport = (): void => {
    const r = importSocketJson(io);
    if (!r.ok) {
      setMsg(`导入失败: ${r.error}`);
      return;
    }
    setSocketDoc(r.doc);
    setMsg(r.warnings.length ? `已导入（${r.warnings.length} 条警告）` : '已导入');
  };

  const scaleValue = selected ? normalizeScale(selected.scale)[0] : 1;

  return (
    <div className="panel se-panel" data-testid="panel-socket-editor">
      <h3>绑点编辑器</h3>

      <div className="se-toolbar">
        <button data-testid="se-add" onClick={onAdd}>+ 新增绑点</button>
        {selId && (
          <button data-testid="se-del" onClick={() => removeSocket(selId)}>删除</button>
        )}
        <span className="se-sep" />
        <button data-testid="se-recenter" onClick={() => requestView('recenter')} title="角色归一化：缩放到标准身高并居中落地">居中落地</button>
        <button data-testid="se-resetcam" onClick={() => requestView('resetCamera')} title="重置相机到默认取景">重置相机</button>
      </div>

      <div className="se-body">
        <ul className="se-list" data-testid="se-list">
          {doc.sockets.length === 0 && <li className="se-empty">暂无绑点，点击「+ 新增绑点」</li>}
          {doc.sockets.map((s) => (
            <li
              key={s.id}
              className={s.id === selId ? 'se-item sel' : 'se-item'}
              onClick={() => setSelectedSocketId(s.id)}
              data-testid={`se-item-${s.id}`}
            >
              <span className="se-item-id">{s.id}</span>
              <span className="se-item-bone">{s.bone || '(未选骨骼)'}</span>
            </li>
          ))}
        </ul>

        {selected ? (
          <div className="se-inspector">
            <label className="se-field">
              <span>id</span>
              <input
                value={selected.id}
                onChange={(e) => updateSocket(selected.id, { id: e.target.value })}
                data-testid="se-id"
              />
            </label>
            <label className="se-field">
              <span>父骨骼</span>
              <input
                value={selected.bone}
                placeholder="hand_r"
                onChange={(e) => updateSocket(selected.id, { bone: e.target.value })}
                data-testid="se-bone"
              />
            </label>
            <label className="se-field">
              <span>道具资源</span>
              <input
                value={selected.assetHint ?? ''}
                placeholder="预览用道具场景 GUID（可空）"
                onChange={(e) => updateSocket(selected.id, { assetHint: e.target.value })}
                data-testid="se-asset"
              />
            </label>

            <Vec3Group
              title="位置偏移 (相对骨骼, 米)"
              cls="red"
              axes={['X 左右', 'Y 上下', 'Z 前后']}
              value={selected.position}
              min={-0.4}
              max={0.4}
              step={0.005}
              onChange={(v) => updateSocket(selected.id, { position: v })}
            />
            <Vec3Group
              title="旋转 (度, XYZ)"
              cls="blue"
              axes={['X 俯仰', 'Y 偏航', 'Z 滚转']}
              value={selected.rotationEulerDegXYZ}
              min={-180}
              max={180}
              step={1}
              onChange={(v) => updateSocket(selected.id, { rotationEulerDegXYZ: v })}
            />

            <div className="se-grp">
              <div className="se-lbl">尺寸</div>
              <SliderRow
                label="scale"
                value={scaleValue}
                min={0.05}
                max={3}
                step={0.01}
                onChange={(n) => updateSocket(selected.id, { scale: n })}
              />
            </div>

            <div className="se-grp">
              <div className="se-lbl">编辑坐标系（不影响导出）</div>
              <div className="se-toggle">
                <label><input type="radio" name="se-coord" checked={coordSpace === 'boneLocal'} onChange={() => setCoordSpace('boneLocal')} /> 骨骼本地</label>
                <label><input type="radio" name="se-coord" checked={coordSpace === 'worldAligned'} onChange={() => setCoordSpace('worldAligned')} /> 世界对齐</label>
              </div>
            </div>
            <div className="se-grp">
              <div className="se-lbl">旋转支点（不影响导出）</div>
              <div className="se-toggle">
                <label><input type="radio" name="se-pivot" checked={pivot === 'geomCenter'} onChange={() => setPivot('geomCenter')} /> 道具几何中心</label>
                <label><input type="radio" name="se-pivot" checked={pivot === 'socketPoint'} onChange={() => setPivot('socketPoint')} /> 主绑点处</label>
              </div>
            </div>
          </div>
        ) : (
          <div className="se-inspector se-muted">选择或新增一个绑点开始编辑</div>
        )}
      </div>

      <ClipScrubber />

      <div className="se-io">
        <div className="se-io-btns">
          <button data-testid="se-export" onClick={onExport}>导出 JSON</button>
          <button data-testid="se-copy" onClick={onCopy}>复制</button>
          <button data-testid="se-import" onClick={onImport}>导入 JSON</button>
          {msg && <span className="se-msg">{msg}</span>}
        </div>
        <textarea
          className="se-out"
          data-testid="se-textarea"
          value={io}
          spellCheck={false}
          onChange={(e) => setIo(e.target.value)}
          placeholder="导出后在此显示；可粘贴 JSON 后点「导入 JSON」"
        />
      </div>
    </div>
  );
}
