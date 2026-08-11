import { expect, test } from 'bun:test';
import { AlarmClock, Box } from 'lucide-react';
import { declaredLucideIcon, lucideIconOrBox } from './lucide-icon';

test('valid declarations support Pascal, kebab, and snake names', () => {
  expect(declaredLucideIcon('AlarmClock')).toBe(AlarmClock);
  expect(declaredLucideIcon('alarm-clock')).toBe(AlarmClock);
  expect(declaredLucideIcon('alarm_clock')).toBe(AlarmClock);
});

test('missing, unknown, arbitrary text, and emoji declarations use Box', () => {
  expect(lucideIconOrBox()).toBe(Box);
  expect(lucideIconOrBox('NotARealLucideIcon')).toBe(Box);
  expect(lucideIconOrBox('</>')).toBe(Box);
  expect(lucideIconOrBox('🎮')).toBe(Box);
});
