// frame-phase-profiler — the Editor's thin adapter over the Engine profiler.
// The Engine owns ProfileCapture v1, phase catalogs, limits, timing, and
// validation. The Editor keeps only its opt-in User Timing marks and the VFX
// phase observer, then exposes bounded capture through the existing Gateway.

import {
	createProfiler,
	validateProfileCapture,
	type ProfileCapture,
	type ProfileResult,
	type Profiler,
	type RecorderSession,
} from "@forgeax/engine-profiler";

const DIAGNOSTICS_KEY = "__forgeaxFramePhaseDiagnostics";
const OBSERVER_CAPTURE_ID = "editor-phase-observer";
const DEFAULT_PROFILE_POLL_MS = 4;

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

export interface FramePhaseProfilerOptions {
	/** Production observer invoked from the same profiler phase owner. */
	readonly onPhaseEnd?: (phase: OpenPhase) => void;
	/** Keep the Engine profiler available for the explicit CPU capture operation. */
	readonly enableCpuCapture?: boolean;
}

export interface CpuProfileCaptureOptions {
	readonly frameLimit: number;
	readonly eventLimit: number;
	readonly timeoutMs: number;
	readonly pollIntervalMs?: number;
}

export type CpuProfileCaptureError = {
	readonly code: string;
	readonly expected: string;
	readonly hint: string;
	readonly detail?: unknown;
};

type PhaseCatalog = ProfileCapture["phaseCatalog"];

const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });

function mark(
	performanceApi: Performance | undefined,
	name: string,
): void {
	if (performanceApi === undefined || typeof performanceApi.mark !== "function") return;
	try {
		performanceApi.mark(name);
	} catch {
		// Diagnostics must not change the editor's frame-loop behavior.
	}
}

function timingSource(source: OpenPhase["source"]): "frame" | "render" {
	return source === "app" ? "frame" : "render";
}

function observerSession(
	performanceApi: Performance | undefined,
	onPhaseEnd: FramePhaseProfilerOptions["onPhaseEnd"],
): RecorderSession {
	let frameId: number | undefined;
	const openPhases: OpenPhase[] = [];
	return {
		captureId: OBSERVER_CAPTURE_ID,
		detail: "owner",
		beginFrame(nextFrameId) {
			frameId = nextFrameId;
			openPhases.length = 0;
			return ok(undefined);
		},
		beginPhase(input) {
			if (frameId !== undefined) {
				openPhases.push(input);
				mark(performanceApi, `forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.begin`);
			}
			return ok(undefined);
		},
		endPhase() {
			const phase = openPhases.pop();
			if (phase !== undefined) {
				if (frameId !== undefined) {
					mark(performanceApi, `forgeax.${timingSource(phase.source)}.phase.${frameId}.${phase.phase}.end`);
				}
				onPhaseEnd?.(phase);
			}
			return ok(undefined);
		},
		recordSkip(input) {
			if (frameId !== undefined) {
				mark(performanceApi, `forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.skip.${input.reason}`);
			}
			return ok(undefined);
		},
		endFrame() {
			frameId = undefined;
			openPhases.length = 0;
			return ok(undefined);
		},
		finish() {
			return {
				ok: false,
				error: {
					code: "capture-state-invalid",
					expected: "an active Engine profiler capture",
					hint: "Start captureCpuProfile before finishing a profile session.",
					detail: { operation: "finish" },
				},
			};
		},
	};
}

function decorateSession(
	raw: RecorderSession,
	performanceApi: Performance | undefined,
	onPhaseEnd: FramePhaseProfilerOptions["onPhaseEnd"],
): RecorderSession {
	let frameId: number | undefined;
	const openPhases: OpenPhase[] = [];
	return {
		captureId: raw.captureId,
		detail: raw.detail,
		beginFrame(nextFrameId) {
			const result = raw.beginFrame(nextFrameId);
			if (result.ok) {
				frameId = nextFrameId;
				openPhases.length = 0;
			}
			return result;
		},
		beginPhase(input) {
			const result = raw.beginPhase(input);
			if (result.ok) {
				openPhases.push(input);
				if (frameId !== undefined) {
					mark(performanceApi, `forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.begin`);
				}
			}
			return result;
		},
		endPhase() {
			const phase = openPhases.at(-1);
			const result = raw.endPhase();
			if (result.ok && phase !== undefined) {
				openPhases.pop();
				if (frameId !== undefined) {
					mark(performanceApi, `forgeax.${timingSource(phase.source)}.phase.${frameId}.${phase.phase}.end`);
				}
				onPhaseEnd?.(phase);
			}
			return result;
		},
		recordSkip(input) {
			const result = raw.recordSkip(input);
			if (result.ok && frameId !== undefined) {
				mark(performanceApi, `forgeax.${timingSource(input.source)}.phase.${frameId}.${input.phase}.skip.${input.reason}`);
			}
			return result;
		},
		endFrame() {
			const result = raw.endFrame();
			if (result.ok) {
				frameId = undefined;
				openPhases.length = 0;
			}
			return result;
		},
		finish() {
			const result = raw.finish();
			if (result.ok) {
				frameId = undefined;
				openPhases.length = 0;
			}
			return result;
		},
	};
}

/**
 * Creates the browser-side profiler used by the performance evidence tool.
 *
 * Normal editor and game sessions return `undefined` when neither User Timing
 * nor an explicit phase callback is enabled, so the frame loop has no profiler
 * adapter to invoke. Opted-in diagnostics receive a non-recording observer;
 * bounded captures are delegated to the Engine-owned profiler and decorated
 * only with those same Editor-side observations.
 */
export function createFramePhaseProfiler(
	options: FramePhaseProfilerOptions = {},
): Profiler | undefined {
	const diagnosticGlobal = globalThis as DiagnosticGlobal;
	const timingEnabled = diagnosticGlobal[DIAGNOSTICS_KEY]?.enabled === true;
	if (!timingEnabled && options.onPhaseEnd === undefined && options.enableCpuCapture !== true) return undefined;

	const performanceApi = timingEnabled ? globalThis.performance : undefined;
	if (
		timingEnabled &&
		(performanceApi === undefined || typeof performanceApi.mark !== "function") &&
		options.onPhaseEnd === undefined
	) {
		return undefined;
	}

	const engineProfiler = createProfiler();
	const observer = observerSession(performanceApi, options.onPhaseEnd);
	const decorated = new WeakMap<RecorderSession, RecorderSession>();
	const sessionFor = (raw: RecorderSession): RecorderSession => {
		const existing = decorated.get(raw);
		if (existing !== undefined) return existing;
		const next = decorateSession(raw, performanceApi, options.onPhaseEnd);
		decorated.set(raw, next);
		return next;
	};

	return {
		registerPhaseCatalog(source, phases) {
			return engineProfiler.registerPhaseCatalog(source, phases);
		},
		startCapture(limits) {
			const result = engineProfiler.startCapture(limits);
			return result.ok ? { ok: true, value: sessionFor(result.value) } : result;
		},
		activeCaptureId() {
			return engineProfiler.activeCaptureId();
		},
		activeSession() {
			const active = engineProfiler.activeSession();
			return active === undefined ? observer : sessionFor(active);
		},
		latestCapture() {
			return engineProfiler.latestCapture();
		},
		get phaseCatalog(): PhaseCatalog {
			return engineProfiler.phaseCatalog;
		},
	};
}

function captureError(
	code: string,
	expected: string,
	hint: string,
	detail?: unknown,
): ProfileResult<never, CpuProfileCaptureError> {
	return {
		ok: false,
		error: { code, expected, hint, ...(detail === undefined ? {} : { detail }) },
	};
}

/** Start one bounded Engine capture and wait for the Engine frame loop to publish it. */
export async function captureCpuProfile(
	profiler: Profiler,
	options: CpuProfileCaptureOptions,
): Promise<ProfileResult<ProfileCapture, CpuProfileCaptureError>> {
	const started = profiler.startCapture({
		frameLimit: options.frameLimit,
		eventLimit: options.eventLimit,
		detail: "owner",
	});
	if (!started.ok) return started;

	const captureId = started.value.captureId;
	const deadline = Date.now() + options.timeoutMs;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROFILE_POLL_MS;
	while (profiler.activeCaptureId() === captureId) {
		if (Date.now() >= deadline) {
			const active = profiler.activeSession();
			if (active?.captureId === captureId) active.finish();
			return captureError(
				"profile-capture-timeout",
				`Engine profiler capture ${captureId} completes within ${options.timeoutMs} ms`,
				"The bounded CPU profile did not reach its frame limit before the deadline.",
				{ captureId, timeoutMs: options.timeoutMs },
			);
		}
		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	const capture = profiler.latestCapture();
	if (capture === undefined || capture.captureId !== captureId) {
		return captureError(
			"profile-capture-missing",
			"the completed Engine profiler capture remains available",
			"The Engine profiler ended without publishing the requested capture.",
			{ captureId },
		);
	}
	const validated = validateProfileCapture(capture);
	if (!validated.ok) return validated;
	if (validated.value.records.length === 0) {
		return captureError(
			"profile-capture-empty",
			"at least one Engine-owned CPU phase record",
			"The bounded capture produced no phase records; zero metrics are not treated as success.",
			{ captureId, phaseCatalog: validated.value.phaseCatalog },
		);
	}
	return { ok: true, value: validated.value };
}
