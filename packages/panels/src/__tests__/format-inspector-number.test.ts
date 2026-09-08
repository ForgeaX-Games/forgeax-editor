import { describe, expect, it } from 'bun:test';
import { formatInspectorNumber, inspectorNumberDecimals } from '../format-inspector-number';

describe('formatInspectorNumber', () => {
  it('limits transform-style vec display to three decimals', () => {
    expect(formatInspectorNumber(1.23456789, { step: 0.1 } as never)).toBe('1.235');
    expect(formatInspectorNumber(0.1000004, { step: 0.1 } as never)).toBe('0.1');
    expect(formatInspectorNumber(2, { step: 0.1 } as never)).toBe('2');
  });

  it('derives decimals from field step', () => {
    expect(inspectorNumberDecimals({ step: 1 } as never)).toBe(0);
    expect(formatInspectorNumber(3.7, { step: 1 } as never)).toBe('4');
    expect(inspectorNumberDecimals({ step: 0.01 } as never)).toBe(4);
    expect(formatInspectorNumber(0.123456, { step: 0.01 } as never)).toBe('0.1235');
  });
});
