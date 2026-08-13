// SettingsPanel — dockable editor Settings panel (viewport preferences).
//
// Every control dispatches `setViewportPreferences` (session op) through the
// gateway — the SAME door the viewport toolbar menus and AI use — and reads
// back via useViewportPreferences, so the panel, the toolbar and the camera
// never diverge. Camera bookmarks list/clear go through the existing
// `cameraBookmark` op.
//
// Self-contained styling (panels must not depend on the interface package);
// class hooks (`fx-set-*`) let hosts theme it, inline styles carry the layout.

import type { CSSProperties, ReactNode } from 'react';
import {
  FLY_SPEED_MAX,
  FLY_SPEED_MIN,
  FOV_MAX,
  FOV_MIN,
  defaultViewportPreferences,
  gateway,
  useViewportPreferences,
  type CameraBookmarkSlot,
  type ViewportPreferencesPatch,
} from '@forgeax/editor-core';
import { useTranslation } from '@forgeax/editor-core/i18n';

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 0',
  fontSize: 12,
};

const labelStyle: CSSProperties = {
  flex: '0 0 45%',
  opacity: 0.85,
};

const valueStyle: CSSProperties = {
  minWidth: 44,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.7,
};

const sectionStyle: CSSProperties = {
  padding: '8px 10px',
  borderBottom: '1px solid rgba(127, 127, 127, 0.2)',
};

const sectionTitleStyle: CSSProperties = {
  margin: '0 0 4px',
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  opacity: 0.6,
};

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  disabled = false,
  onChange,
  testId,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled?: boolean;
  onChange: (next: number) => void;
  testId: string;
}): ReactNode {
  return (
    <div className="fx-set-row" style={rowStyle} data-testid={testId}>
      <span className="fx-set-label" style={labelStyle}>{label}</span>
      <input
        type="range"
        style={{ flex: 1 }}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fx-set-value" style={valueStyle}>{display}</span>
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}): ReactNode {
  return (
    <label className="fx-set-row" style={{ ...rowStyle, cursor: 'pointer' }} data-testid={testId}>
      <span className="fx-set-label" style={labelStyle}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

const BOOKMARK_SLOTS: readonly CameraBookmarkSlot[] = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function SettingsPanel(): ReactNode {
  const { t } = useTranslation();
  const prefs = useViewportPreferences();
  const patch = (p: ViewportPreferencesPatch): void => {
    gateway.dispatch({ kind: 'setViewportPreferences', patch: p }, 'human');
  };
  const perspective = prefs.projection === 'perspective';
  const defaults = defaultViewportPreferences();

  return (
    <div className="panel fx-settings" data-testid="panel-settings" style={{ overflowY: 'auto' }}>
      <div className="fx-set-section" style={sectionStyle}>
        <h3 className="fx-set-section-title" style={sectionTitleStyle}>{t('editor.settings.viewportInteraction')}</h3>
        <SliderRow
          testId="set-mouse-sensitivity"
          label={t('editor.settings.mouseSensitivity')}
          value={prefs.mouseSensitivity}
          min={0.05}
          max={5}
          step={0.05}
          display={prefs.mouseSensitivity.toFixed(2)}
          onChange={(mouseSensitivity) => patch({ mouseSensitivity })}
        />
        <SliderRow
          testId="set-wheel-speed"
          label={t('editor.settings.wheelSpeed')}
          value={prefs.wheelSpeedScalar}
          min={0.1}
          max={4}
          step={0.1}
          display={prefs.wheelSpeedScalar.toFixed(1)}
          onChange={(wheelSpeedScalar) => patch({ wheelSpeedScalar })}
        />
        <ToggleRow
          testId="set-invert-y"
          label={t('editor.settings.invertY')}
          checked={prefs.invertY}
          onChange={(invertY) => patch({ invertY })}
        />
        <ToggleRow
          testId="set-invert-wheel"
          label={t('editor.settings.invertWheel')}
          checked={prefs.wheelDirection === -1}
          onChange={(inverted) => patch({ wheelDirection: inverted ? -1 : 1 })}
        />
        <ToggleRow
          testId="set-grid"
          label="Show grid"
          checked={prefs.gridVisible}
          onChange={(gridVisible) => patch({ gridVisible })}
        />
      </div>

      <div className="fx-set-section" style={sectionStyle}>
        <h3 className="fx-set-section-title" style={sectionTitleStyle}>{t('editor.settings.flight')}</h3>
        <SliderRow
          testId="set-fly-speed"
          label={t('editor.settings.flySpeed')}
          value={prefs.flySpeed}
          min={FLY_SPEED_MIN}
          max={FLY_SPEED_MAX}
          step={0.5}
          display={prefs.flySpeed.toFixed(1)}
          onChange={(flySpeed) => patch({ flySpeed })}
        />
        <SliderRow
          testId="set-boost-multiplier"
          label={t('editor.settings.boostMultiplier')}
          value={prefs.flyBoostMultiplier}
          min={1}
          max={8}
          step={0.5}
          display={`×${prefs.flyBoostMultiplier.toFixed(1)}`}
          onChange={(flyBoostMultiplier) => patch({ flyBoostMultiplier })}
        />
      </div>

      <div className="fx-set-section" style={sectionStyle}>
        <h3 className="fx-set-section-title" style={sectionTitleStyle}>{t('editor.settings.camera')}</h3>
        <div className="fx-set-row" style={rowStyle} data-testid="set-projection">
          <span className="fx-set-label" style={labelStyle}>{t('editor.settings.projection')}</span>
          <div style={{ display: 'flex', gap: 4, flex: 1 }}>
            <button
              type="button"
              data-testid="set-projection-perspective"
              aria-pressed={perspective}
              style={{ flex: 1, fontWeight: perspective ? 600 : 400 }}
              onClick={() => gateway.dispatch({ kind: 'cameraSetProjection', projection: 'perspective' }, 'human')}
            >
              {t('editor.settings.perspective')}
            </button>
            <button
              type="button"
              data-testid="set-projection-orthographic"
              aria-pressed={!perspective}
              style={{ flex: 1, fontWeight: perspective ? 400 : 600 }}
              onClick={() => gateway.dispatch({ kind: 'cameraSetProjection', projection: 'orthographic' }, 'human')}
            >
              {t('editor.settings.orthographic')}
            </button>
          </div>
        </div>
        <SliderRow
          testId="set-fov"
          label={t('editor.settings.fov')}
          value={prefs.fov}
          min={FOV_MIN}
          max={FOV_MAX}
          step={Math.PI / 180}
          display={`${Math.round(prefs.fov * 180 / Math.PI)}°`}
          disabled={!perspective}
          onChange={(fov) => patch({ fov })}
        />
      </div>

      <div className="fx-set-section" style={sectionStyle}>
        <h3 className="fx-set-section-title" style={sectionTitleStyle}>{t('editor.settings.bookmarks')}</h3>
        {BOOKMARK_SLOTS.map((slot) => {
          const saved = prefs.bookmarks[slot] !== undefined;
          return (
            <div className="fx-set-row" style={rowStyle} key={slot} data-testid={`set-bookmark-${slot}`}>
              <span className="fx-set-label" style={labelStyle}>{t('editor.settings.bookmarkSlot', { slot })}</span>
              <span style={{ flex: 1, opacity: 0.6 }}>{saved ? '✓' : t('editor.settings.bookmarkEmpty')}</span>
              <button
                type="button"
                disabled={!saved}
                data-testid={`set-bookmark-clear-${slot}`}
                onClick={() => gateway.dispatch({ kind: 'cameraBookmark', action: 'clear', slot }, 'human')}
              >
                {t('editor.settings.clearBookmark')}
              </button>
            </div>
          );
        })}
      </div>

      <div className="fx-set-section" style={{ ...sectionStyle, borderBottom: 'none' }}>
        <button
          type="button"
          data-testid="set-reset-defaults"
          onClick={() => patch({
            gridVisible: defaults.gridVisible,
            mouseSensitivity: defaults.mouseSensitivity,
            invertY: defaults.invertY,
            wheelDirection: defaults.wheelDirection,
            wheelSpeedScalar: defaults.wheelSpeedScalar,
            flyBoostMultiplier: defaults.flyBoostMultiplier,
            flySpeed: defaults.flySpeed,
            fov: defaults.fov,
            projection: defaults.projection,
          })}
        >
          {t('editor.settings.resetDefaults')}
        </button>
      </div>
    </div>
  );
}
