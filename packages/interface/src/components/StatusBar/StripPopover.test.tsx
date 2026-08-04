import { describe, expect, it } from 'bun:test';
import { fireEvent, render } from '@testing-library/react';
import { StripPopover } from './StripPopover';

describe('StripPopover', () => {
  it('closes Escape from the focused chip or dialog without a document keyboard listener', () => {
    const view = render(
      <StripPopover label="Project" title="Project details">
        <button type="button">Inspect</button>
      </StripPopover>,
    );
    const chip = view.getByRole('button', { name: 'Project' });

    fireEvent.click(chip);
    expect(view.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(chip, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();

    fireEvent.click(chip);
    const inspect = view.getByRole('button', { name: 'Inspect' });
    fireEvent.keyDown(inspect, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
