import { afterEach, describe, expect, it } from "bun:test";

import { captureCpuProfile, createFramePhaseProfiler } from "../frame-phase-profiler";

const originalPerformance = Object.getOwnPropertyDescriptor(
	globalThis,
	"performance",
);
const diagnosticGlobal = globalThis as typeof globalThis & {
	__forgeaxFramePhaseDiagnostics?: { enabled?: boolean };
};

afterEach(() => {
	delete diagnosticGlobal.__forgeaxFramePhaseDiagnostics;
	if (originalPerformance === undefined)
		delete (globalThis as { performance?: Performance }).performance;
	else Object.defineProperty(globalThis, "performance", originalPerformance);
});

describe("createFramePhaseProfiler", () => {
	it("stays absent unless diagnostics are explicitly enabled", () => {
		expect(createFramePhaseProfiler()).toBeUndefined();
	});

	it("keeps production phase observation active without User Timing", () => {
		const ended: string[] = [];
		const profiler = createFramePhaseProfiler({
			onPhaseEnd: ({ source, phase }) => ended.push(`${source}:${phase}`),
		});
		const session = profiler?.activeSession();
		session?.beginFrame(1);
		session?.beginPhase({ source: "render", phase: "features" });
		session?.endPhase();
		expect(ended).toEqual(["render:features"]);
	});

	it("preserves the stable app and render User Timing vocabulary", () => {
		const marks: string[] = [];
		Object.defineProperty(globalThis, "performance", {
			configurable: true,
			value: { mark: (name: string) => marks.push(name) },
		});
		diagnosticGlobal.__forgeaxFramePhaseDiagnostics = { enabled: true };

		const profiler = createFramePhaseProfiler();
		expect(profiler).toBeDefined();
		const session = profiler?.activeSession();
		expect(session).toBeDefined();

		session?.beginFrame(7);
		session?.beginPhase({ source: "app", phase: "frame-total" });
		session?.beginPhase({ source: "render", phase: "extract" });
		session?.endPhase();
		session?.recordSkip({
			source: "render",
			phase: "bind-groups",
			reason: "feature-host-empty",
		});
		session?.endPhase();
		session?.endFrame();

		expect(marks).toEqual([
			"forgeax.frame.phase.7.frame-total.begin",
			"forgeax.render.phase.7.extract.begin",
			"forgeax.render.phase.7.extract.end",
			"forgeax.render.phase.7.bind-groups.skip.feature-host-empty",
			"forgeax.frame.phase.7.frame-total.end",
		]);
	});

	it("delegates bounded captures to the Engine and publishes real records", async () => {
		Object.defineProperty(globalThis, "performance", {
			configurable: true,
			value: { mark: () => undefined, now: () => 1 },
		});
		diagnosticGlobal.__forgeaxFramePhaseDiagnostics = { enabled: true };

		const profiler = createFramePhaseProfiler();
		expect(profiler).toBeDefined();
		profiler?.registerPhaseCatalog("app", ["frame-total"]);
		const capture = captureCpuProfile(profiler!, {
			frameLimit: 1,
			eventLimit: 8,
			timeoutMs: 100,
			pollIntervalMs: 1,
		});
		const session = profiler?.activeSession();
		session?.beginFrame(1);
		session?.beginPhase({ source: "app", phase: "frame-total" });
		session?.endPhase();
		session?.endFrame();

		const result = await capture;
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.schemaVersion).toBe("1.0");
		expect(result.value.timeUnit).toBe("microseconds");
		expect(result.value.records.length).toBeGreaterThan(0);
		expect(result.value.completeness.status).toBe("complete");
		expect(profiler?.latestCapture()?.captureId).toBe(result.value.captureId);
	});

	it("keeps the observer session non-recording when no CPU capture is active", () => {
		Object.defineProperty(globalThis, "performance", {
			configurable: true,
			value: { mark: () => undefined },
		});
		diagnosticGlobal.__forgeaxFramePhaseDiagnostics = { enabled: true };

		const profiler = createFramePhaseProfiler();
		const result = profiler?.activeSession()?.finish();

		expect(result?.ok).toBe(false);
		expect(profiler?.latestCapture()).toBeUndefined();
	});
});
