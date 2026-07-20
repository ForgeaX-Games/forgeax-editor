import { describe, expect, test } from 'bun:test';
import { preferredCliProviderToKernel } from './agent-cli-provider';

describe('preferredCliProviderToKernel', () => {
  test('maps cursor marketplace plugin to cursor-agent kernel', () => {
    expect(preferredCliProviderToKernel('@forgeax-plugin/cli-cursor-agent')).toBe('cursor-agent');
  });

  test('maps forgeax-native to null (EventBus path)', () => {
    expect(preferredCliProviderToKernel('forgeax-native')).toBeNull();
  });

  test('passes through kernel ids', () => {
    expect(preferredCliProviderToKernel('claude-code')).toBe('claude-code');
  });
});
