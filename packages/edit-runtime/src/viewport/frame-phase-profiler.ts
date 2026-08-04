// frame-phase-profiler — opt-in bridge from the engine profiler to browser
// User Timing. The engine owns the phase vocabulary and invokes the profiler;
// the editor only emits marks when the performance harness enables diagnostics
// before app creation.

import type {
	ProfileCapture,
	Profiler,
	RecorderSession,
} from "@forgeax/engine-profiler";

const DIAGNOSTICS_KEY = "__forgeaxFramePhaseDiagnostics";
const CAPTURE_ID = "editor-user-timing";

interface FramePhaseDiagnosticsConfig {
	readonly enabled?: boolean;
}

type DiagnosticGlobal = typeof globalThis & {
	readonly __forgeaxFramePhaseDiagnostics?: FramePhaseDiagnosticsConfig;
};

type OpenPhase = {
	readonly source: "app" | "render";
	readonly phase: string;
};

type PhaseCatalog = ProfileCapture["phaseCatalog"];

function partialCapture(phaseCatalog: PhaseCatalog): ProfileCapture {
	return {
		schemaVersion: "1.0",
		captureId: CAPTURE_ID,
		timeUnit: "microseconds",
		frameLimit: 1,
		eventLimit: 1,
		phaseCatalog,
		records: [],
		completeness: {
			status: "partial",
			retainedEventCount: 0,
			droppedEventCount: 0,
			incompleteReason: "user-timing-transport",
		},
	};
}

/**
 * Creates the browser-side profiler used by the performance evidence tool.
 *
 * Normal editor and game sessions receive `undefined`, so they do not allocate
 * a profiler or emit User Timing marks. The diagnostic implementation follows
 * the current engine `Profiler` boundary while retaining the stable mark names
 * consumed by `scripts/chrome-performance.mjs`.
 */
export function createFramePhaseProfiler(): Profiler | undefined {
	const diagnosticGlobal = globalThis as DiagnosticGlobal;
	if (diagnosticGlobal[DIAGNOSTICS_KEY]?.enabled !== true) return undefined;

	const performanceApi = globalThis.performance;
	if (
		performanceApi === undefined ||
		typeof performanceApi.mark !== "function"
	) {
		return undefined;
	}

	let phaseCatalog: PhaseCatalog = { app: [], render: [] };
	let frameId: number | undefined;
	let active = true;
	let latest: ProfileCapture | undefined;
	const openPhases: OpenPhase[] = [];

	function mark(name: string): void {
		try {
			performanceApi.mark(name);
		} catch {
			// Diagnostics must not change the editor's frame-loop behavior.
		}
	}

	function timingSource(source: OpenPhase["source"]): "frame" | "render" {
		return source === "app" ? "frame" : "render";
	}

	const session: RecorderSession = {
		captureId: CAPTURE_ID,
		beginFrame(nextFrameId) {
			frameId = nextFrameId;
			openPhases.length = 0;
			return { ok: true, value: undefined };
		},
		beginPhase(input) {
			if (frameId === undefined) return { ok: true, value: undefined };
			openPhases.push(input);
			mark(
				`forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.begin`,
			);
			return { ok: true, value: undefined };
		},
		endPhase() {
			const phase = openPhases.pop();
			if (frameId !== undefined && phase !== undefined) {
				mark(
					`forgeax.${timingSource(phase.source)}.phase.${frameId}.${phase.phase}.end`,
				);
			}
			return { ok: true, value: undefined };
		},
		recordSkip(input) {
			if (frameId !== undefined) {
				mark(
					`forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.skip.${input.reason}`,
				);
			}
			return { ok: true, value: undefined };
		},
		endFrame() {
			frameId = undefined;
			openPhases.length = 0;
			return { ok: true, value: undefined };
		},
		finish() {
			latest = partialCapture(phaseCatalog);
			active = false;
			frameId = undefined;
			openPhases.length = 0;
			return { ok: true, value: latest };
		},
	};

	return {
		registerPhaseCatalog(source, phases) {
			phaseCatalog = { ...phaseCatalog, [source]: [...phases] };
			return { ok: true, value: undefined };
		},
		startCapture() {
			active = true;
			latest = undefined;
			return { ok: true, value: session };
		},
		activeCaptureId() {
			return active ? CAPTURE_ID : undefined;
		},
		activeSession() {
			return active ? session : undefined;
		},
		latestCapture() {
			return latest;
		},
		get phaseCatalog() {
			return phaseCatalog;
		},
	};
}
