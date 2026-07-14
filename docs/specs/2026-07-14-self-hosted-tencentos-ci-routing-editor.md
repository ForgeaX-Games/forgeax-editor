# Self-hosted TencentOS CI routing — forgeax-editor

> **Scope:** GitHub Actions runner placement for the **forgeax-editor** repository. This mirrors the
> engine-side routing shipped in forgeax-engine
> [PR #705](https://github.com/ForgeaXGame/forgeax-engine/pull/705) (spec:
> `docs/specs/2026-07-14-self-hosted-tencentos-ci-routing.md` in the engine repo). The workflow YAML
> (`.github/workflows/ci.yml`) is the executable SSOT; this document records the routing rationale and
> the invariants a future CI edit must preserve.

## Goal

Route the editor's trusted, ABI-agnostic build work to the org-level TencentOS Linux x64 runner pool
(`Ubpa`, `Ubpa-2`, `Ubpa-3`, `Ubpa-4`; labels `self-hosted, Linux, X64`) to benefit from persistent
Rust / pnpm / bun / engine-dist caches, while keeping the browser gate — and every fork PR — on
ephemeral GitHub-hosted `ubuntu-latest`.

A self-hosted runner executes repository code with persistent host access, so a **fork** `pull_request`
must never receive a TencentOS runner. The selector sends fork PRs to `ubuntu-latest`; only same-repo
PRs, `main` pushes, and manual runs use the trusted pool.

## Per-job routing

| Job | Work | Runner |
|:--|:--|:--|
| `b2-self-boot` | Rust wgpu-wasm build (cache-miss only) + `bun install` + platform-io test + B2 selfcheck. No `apt-get`, no browser. | **Self-hosted for trusted events; `ubuntu-latest` for fork PRs** |
| `typecheck` | Rust wgpu-wasm build (cache-miss only) + `bun install` + lint + dependency-cruiser + `tsc` + core / edit-runtime unit tests. No `apt-get`, no browser. | **Self-hosted for trusted events; `ubuntu-latest` for fork PRs** |
| `smoke-play` | `playwright install --with-deps chromium` (Ubuntu apt paths) + SwiftShader WebGPU render. | **`ubuntu-latest` always** |
| `ci-docs.yml` (`b2-self-boot`, `typecheck` no-op mirrors) | Instant echo passes so doc-only PRs satisfy the required checks. | **`ubuntu-latest` always** |

`b2-self-boot` + `typecheck` are `main`'s two **required** status checks. `smoke-play` is non-required.

### The selector

Both self-hosted-eligible jobs use one expression:

```yaml
runs-on: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-latest' || fromJSON('["self-hosted", "Linux", "X64"]') }}
```

`head.repo.full_name != github.repository` is the fork test: true only when the PR head lives in a
different repo. Non-PR events (`push`, `workflow_dispatch`) fall through to the self-hosted branch.

## Compatibility boundary — why `smoke-play` stays hosted

TencentOS is **not** an Ubuntu substitute. `smoke-play` runs `bunx playwright install --with-deps
chromium`, which installs Ubuntu system libraries via `apt-get`/`dpkg`. TencentOS provides `dnf`/`yum`,
not `apt-get`, and RPM package names, the lavapipe/SwiftShader ICD path, and the Vulkan loader ABI are
not guaranteed to match. Browser, Chromium, and WebGPU-render gates therefore stay on the validated
GitHub-hosted image until a separately labeled, separately validated runner class exists. An `apt-get`
→ `dnf` text substitution is **not** sufficient.

## Invariants a future CI edit must preserve

### Fork safety

Fork `pull_request` code runs only on ephemeral `ubuntu-latest`. Do **not** use `pull_request_target`
to make fork code eligible for self-hosted execution.

### Cache isolation

`CACHE_RUNNER_SCOPE` (top-level `env`) resolves to `github-hosted-linux-x64` (fork PR) or
`self-hosted-linux-x64` (trusted events) on the same condition as the selector, and is baked into the
engine-dist cache key:

```yaml
key: engine-dist-${{ env.CACHE_RUNNER_SCOPE }}-${{ steps.engine.outputs.sha }}
```

Hosted and self-hosted Linux both report `runner.os == Linux`, so `runner.os` alone is **not** a safe
cache identity. Consequence: the trusted pool builds the engine dist cold once per engine pin (first
self-hosted run) and reuses its own namespace thereafter; `smoke-play` (always hosted) and fork PRs
share the `github-hosted-linux-x64` namespace. A future Ubuntu self-hosted class must get its own label
and cache scope before sharing work with TencentOS.

### Tool provisioning

A generic self-hosted runner does **not** imply GitHub-hosted image tools:

- `b2-self-boot` + `typecheck` **split** wasm-pack setup by runner class. The TencentOS runner exports
  `BASH_FUNC_*` environment entries and `taiki-e/install-action` correctly rejects shell-function
  injection, so it cannot run there. Self-hosted downloads the official static
  `x86_64-unknown-linux-musl` v0.14.0 archive by `curl`; GitHub-hosted keeps `taiki-e/install-action`.
  `smoke-play` (always hosted) keeps the single action step.
- Each self-hosted-eligible job has a `Verify self-hosted Linux prerequisites` preflight
  (`command -v sudo`, guarded by `runner.environment == 'self-hosted'`) so a mis-provisioned worker
  fails fast rather than deep in the build.

## Operational prerequisite

The org-level TencentOS runner group must be **granted access to `ForgeaXGame/forgeax-editor`** (Org
Settings → Actions → Runner groups → add repository), the same pool the engine uses. Until then,
self-hosted jobs queue indefinitely. The `GHA` secret (private-submodule PAT) is already set on this
repo.

For runner lifecycle incidents, see the engine spec's "Capacity and operations" section — the runner
hosts are shared.

## Future CI edit checklist

Before changing a job's `runs-on`:

1. Classify the workload: pure build, Ubuntu browser/Vulkan dependency, or platform-specific coverage.
2. Route fork-PR code to ephemeral hosted execution.
3. Select a runner class by required runtime + ABI, not only CPU architecture.
4. Namespace cache keys by runner class (`CACHE_RUNNER_SCOPE`); never rely on `runner.os` across the
   distribution boundary.
5. Keep browser / lavapipe gates on the validated hosted image unless a measured migration replaces it.
6. Run `actionlint .github/workflows/*.yml` and confirm job placement in the GitHub Actions UI.
