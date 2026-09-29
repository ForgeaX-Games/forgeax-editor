import { afterEach, describe, expect, test } from 'bun:test';
import { getLocale, setLocale, t } from '../index';

const originalLocale = getLocale();

afterEach(() => {
  setLocale(originalLocale);
});

describe('standalone recovery locale ownership', () => {
  test('provides the complete English recovery action set', () => {
    setLocale('en');
    expect({
      title: t('standaloneRecovery.title'),
      retry: t('standaloneRecovery.retry'),
      remount: t('standaloneRecovery.remount'),
      reloadApplication: t('standaloneRecovery.reloadApplication'),
    }).toEqual({
      title: 'UI render crashed',
      retry: 'Retry',
      remount: 'Reload this region',
      reloadApplication: 'Reload Studio',
    });
    expect(t('standaloneRecovery.hint')).toContain('The desktop app has no address bar');
  });

  test('provides the complete Chinese recovery action set', () => {
    setLocale('zh');
    expect({
      title: t('standaloneRecovery.title'),
      retry: t('standaloneRecovery.retry'),
      remount: t('standaloneRecovery.remount'),
      reloadApplication: t('standaloneRecovery.reloadApplication'),
    }).toEqual({
      title: '界面渲染崩溃',
      retry: '重试',
      remount: '重载此区域',
      reloadApplication: '重新加载 Studio',
    });
    expect(t('standaloneRecovery.hint')).toContain('桌面 app 无地址栏');
  });
});
