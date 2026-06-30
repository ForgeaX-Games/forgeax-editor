/** Ambient scene layer (forgeax-preview port; decorative, pointer-events: none). */
export function SceneBackground() {
  return (
    <div className="scene-fx" aria-hidden>
      <div className="scene-noise" />
      <div className="scene-orb scene-orb--lime" />
      <div className="scene-orb scene-orb--teal" />
      <div className="scene-orb scene-orb--violet" />
      <div className="scene-sheen" />
      <div className="scene-grid" />
    </div>
  );
}
