// @forgeax/engine-rhi-debug/src/cli -- capture-frame / inspect-at CLI subcommands.
//
// Provides two CLI subcommands for frame recording and offline inspection.
// Follows forgeax-console CLI style with --help output containing flag tables
// and example invocations (charter F1 + P1: AI subagent self-learns via --help).
//
// Subcommands:
//   capture-frame --frames=N --label=X --target=ws://host:port   -> output JSON
//   inspect-at <tapePath> <drawIdx> --fields=bindings,rt --target=...  -> output JSON
//
// The JSON-RPC inspector uses InspectorClient.execute(script) where `script`
// is a JavaScript expression string sent to the `execute` method.
// We compose script strings that invoke the debug.* RPC methods registered
// on the Registry.
//
// Related: requirements AC-22 / IS-7; m7-2.

import { defaultConnect } from '@forgeax/engine-types/inspector-client';

// ============================================================================
// Help text generation
// ============================================================================

/**
 * Capture frame help text with flag table and example invocation.
 */
export function getCaptureFrameHelp(): string {
  return [
    'Usage: capture-frame [--frames=N] [--label=STR] [--target=WS]',
    '',
    'Capture N frames from a running forgeax engine via WebSocket JSON-RPC.',
    '',
    'Flags:',
    '  --frames=N     Number of frames to capture (default: 1).',
    '  --label=STR    Optional label for the capture run.',
    '  --target=WS    WebSocket target URL (default: ws://localhost:5732).',
    '',
    'Example:',
    '  forgeax-engine-console capture-frame --frames=1 --label=test',
    '',
    'Output:',
    '  JSON object with tapePaths array containing runId, tapePath, and reportPath.',
  ].join('\n');
}

/**
 * Inspect at help text with flag table and example invocation.
 */
export function getInspectAtHelp(): string {
  return [
    'Usage: inspect-at <tapePath> <drawIdx> [--fields=LIST] [--target=WS]',
    '',
    'Inspect a specific draw index within a captured tape.',
    '',
    'Arguments:',
    '  tapePath     Path to the .tape.bin file to inspect.',
    '  drawIdx      Global draw event index to inspect (integer >= 0).',
    '',
    'Flags:',
    '  --fields=LIST   Comma-separated fields to include: bindings,drawCall,rt (default: all).',
    '  --target=WS     WebSocket target URL (default: ws://localhost:5732).',
    '',
    'Example:',
    '  forgeax-engine-console inspect-at .forgeax-debug/2026-06-12T120000Z-abcd/frame-0.tape.bin 42 --fields=bindings,rt',
    '',
    'Output:',
    '  JSON InspectReport with frameIdx, drawIdx, passIdx, and requested fields.',
  ].join('\n');
}

// ============================================================================
// CLI command implementations
// ============================================================================

/**
 * Execute capture-frame command.
 *
 * Connects to the target WebSocket, sends an execute script that calls
 * debug.captureFrame via the RPC Registry, and outputs the result as JSON.
 */
export async function runCaptureFrame(options: {
  frames: number;
  label: string | undefined;
  target: string | undefined;
}): Promise<void> {
  const target = options.target ?? 'ws://localhost:5732';
  const connectResult = await defaultConnect(target);
  if (!connectResult.ok) {
    process.stderr.write(`Error: [${connectResult.error.code}] ${connectResult.error.hint}\n`);
    process.exit(1);
  }
  const client = connectResult.value;

  try {
    // Build the script: call debug.captureFrame with frames + optional label
    const framesJson = JSON.stringify(options.frames);
    const labelExpr = options.label !== undefined ? JSON.stringify(options.label) : 'undefined';
    const script = `debug.captureFrame({ frames: ${framesJson}, label: ${labelExpr} })`;

    const rawResult = await client.execute(script);
    const result = rawResult as Record<string, unknown> | undefined;

    if (result !== undefined && typeof result === 'object' && result.error !== undefined) {
      const err = result.error as { code?: string; hint?: string };
      process.stderr.write(
        `Error: [${err.code ?? 'unknown'}] ${err.hint ?? JSON.stringify(result.error)}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result ?? {}, null, 2));
    process.stdout.write('\n');
    await client.dispose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

/**
 * Execute inspect-at command.
 *
 * Connects to the target WebSocket, sends an execute script that calls
 * debug.inspectAt via the RPC Registry, and outputs the result as JSON.
 */
export async function runInspectAt(options: {
  tapePath: string;
  drawIdx: number;
  fields: string | undefined;
  target: string | undefined;
}): Promise<void> {
  const target = options.target ?? 'ws://localhost:5732';
  const connectResult = await defaultConnect(target);
  if (!connectResult.ok) {
    process.stderr.write(`Error: [${connectResult.error.code}] ${connectResult.error.hint}\n`);
    process.exit(1);
  }
  const client = connectResult.value;

  try {
    // Build the script: call debug.inspectAt with tapePath, drawIdx, optional fields
    const tapePathJson = JSON.stringify(options.tapePath);
    const drawIdxJson = JSON.stringify(options.drawIdx);
    const fieldsExpr =
      options.fields !== undefined
        ? JSON.stringify(options.fields.split(',').map((f) => f.trim()))
        : 'undefined';
    const script = `debug.inspectAt({ tapePath: ${tapePathJson}, drawIdx: ${drawIdxJson}, fields: ${fieldsExpr} })`;

    const rawResult = await client.execute(script);
    const result = rawResult as Record<string, unknown> | undefined;

    if (result !== undefined && typeof result === 'object' && result.error !== undefined) {
      const err = result.error as { code?: string; hint?: string };
      process.stderr.write(
        `Error: [${err.code ?? 'unknown'}] ${err.hint ?? JSON.stringify(result.error)}\n`,
      );
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result ?? {}, null, 2));
    process.stdout.write('\n');
    await client.dispose();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exit(1);
  }
}

// ============================================================================
// Main CLI entry (parseArgs-style dispatch)
// ============================================================================

/**
 * Parse and dispatch CLI arguments.
 *
 * Expects argv in the form:
 *   node cli.mjs capture-frame --frames=1 --label=test
 *   node cli.mjs inspect-at <tapePath> 42 --fields=bindings,rt
 */
export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2); // skip node and script path

  if (args.length === 0) {
    process.stderr.write('Usage: rhi-debug-cli <capture-frame|inspect-at> [args...]\n');
    process.exit(1);
  }

  const subcommand = args[0];

  if (subcommand === 'capture-frame') {
    await captureFrameDispatch(args.slice(1));
  } else if (subcommand === 'inspect-at') {
    await inspectAtDispatch(args.slice(1));
  } else {
    process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
    process.stderr.write('Usage: rhi-debug-cli <capture-frame|inspect-at> [args...]\n');
    process.exit(1);
  }
}

/**
 * Parse capture-frame arguments and dispatch.
 */
async function captureFrameDispatch(args: string[]): Promise<void> {
  let frames = 1;
  let label: string | undefined;
  let target: string | undefined;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(getCaptureFrameHelp());
      process.stdout.write('\n');
      process.exit(0);
    }

    const frameMatch = arg.match(/^--frames=(\d+)$/);
    if (frameMatch) {
      const v = frameMatch[1];
      if (v !== undefined) frames = parseInt(v, 10);
      continue;
    }

    const labelMatch = arg.match(/^--label=(.+)$/);
    if (labelMatch) {
      const v = labelMatch[1];
      if (v !== undefined) label = v;
      continue;
    }

    const targetMatch = arg.match(/^--target=(.+)$/);
    if (targetMatch) {
      const v = targetMatch[1];
      if (v !== undefined) target = v;
      continue;
    }

    process.stderr.write(`Unknown argument: ${arg}\n`);
    process.exit(1);
  }

  await runCaptureFrame({ frames, label, target });
}

/**
 * Parse inspect-at arguments and dispatch.
 */
async function inspectAtDispatch(args: string[]): Promise<void> {
  let tapePath: string | undefined;
  let drawIdx: number | undefined;
  let fields: string | undefined;
  let target: string | undefined;
  let position = 0;

  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(getInspectAtHelp());
      process.stdout.write('\n');
      process.exit(0);
    }

    const fieldsMatch = arg.match(/^--fields=(.+)$/);
    if (fieldsMatch) {
      const v = fieldsMatch[1];
      if (v !== undefined) fields = v;
      continue;
    }

    const targetMatch = arg.match(/^--target=(.+)$/);
    if (targetMatch) {
      const v = targetMatch[1];
      if (v !== undefined) target = v;
      continue;
    }

    // Positional arguments
    if (!arg.startsWith('--')) {
      if (position === 0) {
        tapePath = arg;
        position++;
      } else if (position === 1) {
        const idx = parseInt(arg, 10);
        if (Number.isNaN(idx)) {
          process.stderr.write(`Invalid drawIdx: ${arg} (must be an integer)\n`);
          process.exit(1);
        }
        drawIdx = idx;
        position++;
      } else {
        process.stderr.write(`Unknown extra argument: ${arg}\n`);
        process.exit(1);
      }
    }
  }

  if (tapePath === undefined) {
    process.stderr.write('Missing required argument: <tapePath>\n');
    process.exit(1);
  }
  if (drawIdx === undefined) {
    process.stderr.write('Missing required argument: <drawIdx>\n');
    process.exit(1);
  }

  await runInspectAt({ tapePath, drawIdx, fields, target });
}
