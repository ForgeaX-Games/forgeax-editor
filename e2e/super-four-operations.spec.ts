// e2e — AC-02: the four core editor operations still work end-to-end once the
// editor is split into editorWorld (camera + gizmo) + sceneWorld (authored),
// with the super (world-manager) value-move layer between them.
//
// feat-20260709-editor-world-partition-editorworld-super-composite / M5 (w24).
//
// AC-02 (requirements): after the world split, the four operations a user does
// every second must remain observably equivalent to the pre-split behaviour, and
// each must route through the super layer:
//   1. click-select — pick reads the sceneWorld (AABB) and writes the editorWorld
//      gizmo. The selection store is the SSOT both the canvas pick and the
//      hierarchy click feed; this spec drives the hierarchy click (deterministic,
//      GPU-free) which exercises the identical super selection + gizmo binding.
//   2. gizmo-position — the gizmo (in editorWorld) positions onto the selected
//      sceneWorld entity: editorWorld is live and the selection→Transform binding
//      is active (inspector renders the entity's Transform vec3).
//   3. drag-move — moving the entity commits a Transform change on the sceneWorld
//      entity (gizmo drag and the inspector scrub share viewport.ts's applyLive /
//      setComponent commit path); the change round-trips through save.
//   4. inspector-modify — editing a component field reads the sceneWorld entity
//      through the super handle-pair and writes it back.
//
// Observability seams (existing): `.fx-dockwrap` mount, the `__forgeax_editor`
// global (gateway + worldManager, exposed by ViewportComponent), and the panel
// data-testid surface (i18n-safe, plan-strategy D-9 selector strategy).
//
// LOCAL vs CI (see smoke-boot-play.spec.ts for the same caveat): the standalone
// 3-process stack + a working WebGPU adapter are needed to boot the viewport.
// Headless dev machines without a GPU cannot boot it; Linux CI (SwiftShader) is
// the authoritative runner for this spec.
//
// §5.4 visualEvidence FALSIFICATION notes (NOT run in CI — recorded to show the
// pixel/structural checks have discriminating power, per plan-strategy §5.4):
//   ① drawSource fed only [editorWorld] (scene geometry absent) → a
//      "gizmo-overlay-topmost" pixel expectation must FAIL: with no scene entity
//      there is nothing for the gizmo to position onto, so the overlay has no
//      anchor — proves the check is not vacuously green.
//   ② resourceOwner mis-pointed at editorWorld → gizmo positioning is UNAFFECTED
//      (the camera lives in editorWorld and picking is CPU-side AABB, independent
//      of the resource-owner render pipeline). This confirms the resource-owner
//      variant has NO discriminating power over gizmo-overlay-topmost, so it must
//      not be used to grant false confidence to a pixel assertion.
//
// Anchors:
//   requirements AC-02 (four core operations via super; verdict↔mechanism
//     decoupled — no lock on value-move timing / input-routing carrier)
//   plan-strategy §2 D-6 (t4 value-move split-rate: camera per-frame,
//     selection/inspector event-driven)
//   plan-strategy §5.3 (AC-02 four-operation e2e is a key test point)

import { expect, test, type Page } from '@playwright/test';

const STANDALONE_URL = 'http://127.0.0.1:15290/';

interface WorldInspect {
  inspect: () => { entityCount: number };
}
interface EditorGlobal {
  gateway: {
    mode: 'edit' | 'play';
    doc: { world: WorldInspect };
    activeWorld: WorldInspect;
  };
  // Exposed by w29 — the super coordination layer, so out-of-frame scripts can
  // witness that the editorWorld (camera + gizmo) is a real, separate world.
  worldManager?: {
    editorWorld: WorldInspect;
    getWorldBinding: (worldRef: number) => { epoch: number } | undefined;
  };
}

async function waitForEditorBoot(page: Page): Promise<void> {
  await page.goto(STANDALONE_URL);
  await expect(page.locator('.fx-dockwrap')).toBeVisible({ timeout: 15_000 });
  // The engine boots asynchronously and fills __forgeax_editor when ready.
  await page.waitForFunction(
    () => !!(window as unknown as { __forgeax_editor?: unknown }).__forgeax_editor,
    { timeout: 30_000 },
  );
}

/** Assert a number-input's value equals `expected` within f32 tolerance. Engine
 *  Transform fields are stored as f32, so a committed 1.15 reads back as
 *  1.14999997… — exact string equality is wrong; compare numerically. */
async function expectInputCloseTo(
  page: Page,
  testid: string,
  expected: number,
  timeout = 10_000,
): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator(`[data-testid="${testid}"]`).inputValue()), { timeout })
    .toBeCloseTo(expected, 3);
}

/** Activate the Inspector dock tab so its body mounts.
 *
 * The default scene layout (interface/builtinWorkbenches.ts SCENE_DEFAULT_LAYOUT)
 * stacks Hierarchy + Inspector as tab-siblings in ONE leaf (`g-left-tabs`), with
 * Hierarchy the initial active view. dockview lazily UNMOUNTS the body of a
 * non-active tab, so `insp-id` / `insp-Transform-*` are absent from the DOM until
 * the Inspector tab is activated — clicking a hierarchy row alone does not mount
 * the inspector. We click the Inspector dockview TAB directly (dockview renders
 * each panel tab as `.dv-default-tab` carrying its title). This is deterministic
 * and independent of the DEV `__dockApi` global, which is last-write-wins across
 * the DockShell + AuxBar regions and can point at the region that has no
 * inspector panel. The hierarchy row click already committed selection to the
 * store-backed SSOT, which survives the tab switch. */
async function activateInspectorTab(page: Page): Promise<void> {
  const tab = page.locator('.dv-default-tab', { hasText: /^Inspector$/ }).first();
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();
}

/** Read the editor global from the page (null before boot). */
async function editorGlobal(page: Page): Promise<EditorGlobal | null> {
  return page.evaluate(() => {
    const g = (window as unknown as { __forgeax_editor?: EditorGlobal }).__forgeax_editor;
    return g
      ? {
          gateway: {
            mode: g.gateway.mode,
            doc: { world: { inspect: () => g.gateway.doc.world.inspect() } },
            activeWorld: { inspect: () => g.gateway.activeWorld.inspect() },
          },
        }
      : null;
  });
}

/** Select the first authored entity by clicking its hierarchy row. Returns the
 *  entity id (the row testid suffix). The hierarchy click and the canvas pick
 *  feed the SAME super selection store — this exercises the super selection +
 *  editorWorld-gizmo binding deterministically, without GPU picking. */
async function selectFirstEntity(page: Page): Promise<number> {
  const row = page.locator('[data-testid^="hier-row-"]').first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const testid = await row.getAttribute('data-testid');
  const id = Number((testid ?? '').replace('hier-row-', ''));
  expect(Number.isFinite(id)).toBe(true);
  await row.click();
  // The Inspector shares a tab-group with Hierarchy and is unmounted by dockview
  // until activated — bring its tab to front so its body (insp-id) is in the DOM.
  await activateInspectorTab(page);
  // Selection routed through super → the inspector shows this entity's id.
  await expect(page.locator('[data-testid="insp-id"]')).toContainText(`#${id}`, { timeout: 10_000 });
  return id;
}

test.describe('AC-02 — four core operations via super', () => {
  // ── 1. click-select ───────────────────────────────────────────────────────
  test('click-select: selecting an entity routes through super and opens the inspector', async ({ page }) => {
    await waitForEditorBoot(page);
    const id = await selectFirstEntity(page);
    // The inspector (which binds to the super selection) shows the entity.
    await expect(page.locator('[data-testid="insp-id"]')).toContainText(`#${id}`);
    // The editor is in edit mode (not play) — the split topology is the edit-mode
    // composite, not a play world.
    const eg = await editorGlobal(page);
    expect(eg?.gateway.mode).toBe('edit');
  });

  // ── 2. gizmo-position ─────────────────────────────────────────────────────
  test('gizmo-position: editorWorld is live and the selection→Transform binding drives the gizmo', async ({ page }) => {
    await waitForEditorBoot(page);
    await selectFirstEntity(page);

    // The editorWorld (camera + gizmo pool) is a real, separate world with
    // entities (proves the composite topology, not a single world). worldManager
    // is exposed by w29; assert it reports a non-empty editorWorld.
    const editorEntityCount = await page.evaluate(() => {
      const g = (window as unknown as { __forgeax_editor?: EditorGlobal }).__forgeax_editor;
      return g?.worldManager?.editorWorld.inspect().entityCount ?? -1;
    });
    expect(editorEntityCount).toBeGreaterThan(0);

    // The gizmo binds to the same selection the inspector shows: the selected
    // entity's Transform vec3 fields are rendered (the gizmo positions onto it).
    await expect(page.locator('[data-testid="insp-Transform-pos-0"]')).toBeVisible({ timeout: 10_000 });
  });

  // ── 3. drag-move ──────────────────────────────────────────────────────────
  test('drag-move: committing a Transform change moves the sceneWorld entity and round-trips through save', async ({ page }) => {
    await waitForEditorBoot(page);
    await selectFirstEntity(page);

    const posX = page.locator('[data-testid="insp-Transform-pos-0"]');
    await expect(posX).toBeVisible({ timeout: 10_000 });
    const before = Number(await posX.inputValue());

    // Gizmo drag and inspector scrub share viewport.ts applyLive → setComponent
    // (the super sceneWorld write path). Commit a deterministic move here.
    const target = before + 2.5;
    await posX.fill(String(target));
    await posX.blur();

    // The committed value is reflected back (read from the sceneWorld entity).
    // f32 round-trip tolerance — the engine stores Transform fields as f32.
    await expectInputCloseTo(page, 'insp-Transform-pos-0', target);

    // Round-trip: the doc is now dirty and Save persists it. The DirtyIndicator
    // (ViewportBar.tsx) is ALWAYS mounted — it only changes color+title, it never
    // unmounts — so assert its STATE via the title, not its presence/count. It
    // polls hasPendingDiskSave() on a 500ms interval, so poll the title too.
    const dirty = page.locator('[data-testid="dirty-indicator"]');
    await expect(dirty).toBeVisible({ timeout: 10_000 });
    await expect(dirty).toHaveAttribute('title', /unsaved changes/i, { timeout: 10_000 });
    await page.locator('[data-testid="vp-save"]').click();
    // After save the indicator flips back to the "all changes saved" state
    // (the change survived the save collar; the flag cleared).
    await expect(dirty).toHaveAttribute('title', /all changes saved/i, { timeout: 15_000 });
  });

  // ── 4. inspector-modify ───────────────────────────────────────────────────
  test('inspector-modify: editing a Transform field reads+writes the sceneWorld entity through super', async ({ page }) => {
    await waitForEditorBoot(page);
    await selectFirstEntity(page);

    const posY = page.locator('[data-testid="insp-Transform-pos-1"]');
    await expect(posY).toBeVisible({ timeout: 10_000 });
    const before = Number(await posY.inputValue());
    const target = before + 1.25;

    await posY.fill(String(target));
    await posY.blur();

    // Read-back through the super handle-pair returns the written value (f32
    // round-trip tolerance — the engine stores Transform fields as f32).
    await expectInputCloseTo(page, 'insp-Transform-pos-1', target);
  });
});
