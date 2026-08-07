// Render-input diagnostics for the in-process editor viewport.
//
// Camera.fov is an engine value in radians. Keep this contract check small and
// structural: it catches projection inputs that can produce a visibly invalid
// frame without turning a visual preference into a smoke assertion.

export interface InvalidPerspectiveFov {
  readonly code: 'render-camera-invalid-projection';
  readonly field: 'fov';
  readonly actual: number;
  readonly expected: 'finite perspective fov in (0, π) radians';
  readonly hint: 'Camera.fov is stored in radians; use Math.PI / 3 for 60°.';
}

export function validatePerspectiveFov(fov: number): InvalidPerspectiveFov | undefined {
  if (Number.isFinite(fov) && fov > 0 && fov < Math.PI) return undefined;
  return {
    code: 'render-camera-invalid-projection',
    field: 'fov',
    actual: fov,
    expected: 'finite perspective fov in (0, π) radians',
    hint: 'Camera.fov is stored in radians; use Math.PI / 3 for 60°.',
  };
}
