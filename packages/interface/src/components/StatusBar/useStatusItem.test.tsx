import { describe, expect, it } from 'bun:test';
import React from 'react';
import { act, render } from '@testing-library/react';
import { createAppHost, HostProvider } from '../../core/app-shell';
import { useStatusItem } from './useStatusItem';

describe('useStatusItem', () => {
  it('keeps one contribution while rendering the owner latest state', async () => {
    const { host } = createAppHost();

    function Owner({ label }: { label: string }) {
      useStatusItem('test.live', 'statusbar.left', () => <span>{label}</span>);
      return null;
    }

    const view = render(
      <HostProvider value={host}>
        <Owner label="first" />
      </HostProvider>,
    );
    await act(async () => {});

    const first = host.panels.stripItems?.['test.live'];
    expect(first).toBeDefined();

    view.rerender(
      <HostProvider value={host}>
        <Owner label="latest" />
      </HostProvider>,
    );
    await act(async () => {});

    const latest = host.panels.stripItems?.['test.live'];
    expect(latest).toBe(first);
    if (latest?.item.type !== 'custom') throw new Error('expected custom status item');

    const chip = render(<>{latest.item.render()}</>);
    expect(chip.getByText('latest')).toBeTruthy();
  });
});
