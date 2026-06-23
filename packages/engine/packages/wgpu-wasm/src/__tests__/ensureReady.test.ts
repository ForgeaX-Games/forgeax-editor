// packages/wgpu-wasm/src/__tests__/ensureReady.test.ts — singleton-wrapper contract
// (plan-strategy D-P3 / research F-4).
//
// The three assertions below are the SSOT for the ensureReady contract:
//
// 1. Reference equality across calls (charter proposition 6 Idempotency):
//    ensureReady() === ensureReady() — N calls return the same Promise reference.
// 2. Reference equality across awaits: (await ensureReady()) === (await ensureReady())
//    — the resolved wasm namespace is the same object, N times.
// 3. Permanent reject on failure (charter proposition 4 Explicit Failure):
//    if init rejects, subsequent calls observe the same rejection without re-running
//    init (partial wasm loads have undefined behaviour, so we surface the original
//    error every time).
//
// The pkg/* imports are mocked because the wasm artefact does not exist until w4
// runs `bash build.sh`; tests focus on the singleton wrapper logic only — wasm load
// itself is exercised by integration tests in @forgeax/engine-rhi-wgpu + @forgeax/engine-naga.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track the number of init() invocations so we can assert "no second call after success".
/** @internal */
let _initCallCount = 0;
/** @internal */
let _initBehaviour: 'success' | 'reject' = 'success';

vi.mock('../../pkg/wgpu_wasm.js', () => {
  return {
    // Mock the wasm namespace surface (a placeholder identity object stays sufficient
    // for reference-equality assertions; production wasm symbols are not exercised
    // here — that responsibility belongs to integration tests).
    default: vi.fn((_input: unknown) => {
      _initCallCount += 1;
      if (_initBehaviour === 'reject') {
        return Promise.reject(new Error('mock init failure'));
      }
      return Promise.resolve({});
    }),
    parse: vi.fn(),
    validate: vi.fn(),
    emit_reflection: vi.fn(),
    RhiWgpuInstance: { create: vi.fn() },
  };
});

// Mock node:fs/promises so the Node branch of _loadWasm() does not require a
// real wasm artefact on disk (the singleton wrapper's contract is the wasm-load
// boundary itself; the byte content is irrelevant to the contract tests).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => new Uint8Array(0)),
}));

describe('ensureReady singleton wrapper', () => {
  beforeEach(async () => {
    // Reset module state so each test exercises a fresh _instance closure.
    _initCallCount = 0;
    _initBehaviour = 'success';
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the same Promise reference across N calls (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const p1 = mod.ensureReady();
    const p2 = mod.ensureReady();
    const p3 = mod.ensureReady();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    // init() must be called exactly once even after 3 ensureReady() calls.
    await p1;
    expect(_initCallCount).toBe(1);
  });

  it('returns the same wasm namespace reference across N awaits (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const ns1 = await mod.ensureReady();
    const ns2 = await mod.ensureReady();
    expect(ns1).toBe(ns2);
    expect(_initCallCount).toBe(1);
  });

  it('keeps the rejected Promise cached after init failure (charter proposition 4 permanent reject)', async () => {
    _initBehaviour = 'reject';
    const mod = await import('../index.js');
    const p1 = mod.ensureReady();
    const p2 = mod.ensureReady();
    expect(p1).toBe(p2);
    // Both calls share the same rejection (no retry).
    await expect(p1).rejects.toThrow('mock init failure');
    await expect(p2).rejects.toThrow('mock init failure');
    expect(_initCallCount).toBe(1);
  });
});
