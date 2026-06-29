// G-2 case A test entry — renders <EditSurface slug="demo" /> so the
// Playwright e2e spec can assert the iframe is present with the correct src.
//
// This file is a test fixture, not a demo. It will fail to compile until
// w13 (EditSurface) and w16 (./edit pass-through) are implemented — that
// is the red stage of the e2e test.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Once w13+w16 are implemented, this import will resolve.
// In the red stage, it will be a compile error.
import { EditSurface } from '@forgeax/editor/edit';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <EditSurface slug="demo" />
    </StrictMode>,
  );
}