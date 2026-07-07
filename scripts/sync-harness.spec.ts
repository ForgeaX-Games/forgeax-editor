// @ts-nocheck
import { describe, expect, it } from 'bun:test';
import { resolveCloneUrl } from './sync-harness.mjs';

const trueProbe = () => true;
const falseProbe = () => false;
const captureWarn = () => {
  const buf: string[] = [];
  return { warn: (msg: string) => buf.push(msg), buf };
};

describe('editor sync-harness resolveCloneUrl', () => {
  const HTTPS = 'https://github.com/ForgeaXGame/forgeax-editor-harness.git';

  it('non-github url: returned unchanged', () => {
    const { warn } = captureWarn();
    const r = resolveCloneUrl('https://gitlab.example/foo.git', {}, trueProbe, warn);
    expect(r).toEqual({ url: 'https://gitlab.example/foo.git', strategy: 'https-noauth' });
  });

  it('SSH probe true: rewrite to git@github.com:', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, {}, trueProbe, warn);
    expect(r).toEqual({ url: 'git@github.com:ForgeaXGame/forgeax-editor-harness.git', strategy: 'ssh' });
    expect(buf).toEqual([]);
  });

  it('SSH probe false + GH_TOKEN: rewrite to x-access-token URL', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, { GH_TOKEN: 'ghp_pat' }, falseProbe, warn);
    expect(r).toEqual({
      url: 'https://x-access-token:ghp_pat@github.com/ForgeaXGame/forgeax-editor-harness.git',
      strategy: 'pat',
    });
    expect(buf).toEqual([]);
  });

  it('SSH probe false + GITHUB_TOKEN (fallback env name)', () => {
    const { warn } = captureWarn();
    const r = resolveCloneUrl(HTTPS, { GITHUB_TOKEN: 'ghs_pat' }, falseProbe, warn);
    expect(r.strategy).toBe('pat');
    expect(r.url).toBe('https://x-access-token:ghs_pat@github.com/ForgeaXGame/forgeax-editor-harness.git');
  });

  it('SSH probe false + no token: unchanged HTTPS + loud warn', () => {
    const { warn, buf } = captureWarn();
    const r = resolveCloneUrl(HTTPS, {}, falseProbe, warn);
    expect(r).toEqual({ url: HTTPS, strategy: 'https-noauth' });
    expect(buf).toHaveLength(1);
    expect(buf[0]).toMatch(/no GitHub SSH key or GH_TOKEN detected/);
    expect(buf[0]).toMatch(/forgeax-editor-harness/);
  });
});
