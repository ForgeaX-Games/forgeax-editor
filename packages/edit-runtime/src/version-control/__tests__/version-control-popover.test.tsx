import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionControlPopover } from '../version-control-popover';

describe('VersionControlPopover', () => {
  it('renders the closed Editor-owned status item without materializing portal content', () => {
    const markup = renderToStaticMarkup(
      <VersionControlPopover>
        <button type="button">Inspect versions</button>
      </VersionControlPopover>,
    );

    expect(markup).toContain('aria-label="Version control"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('fx-version-control-chip');
    expect(markup).not.toContain('Inspect versions');
  });
});
