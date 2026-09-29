import {accessSync, constants} from 'node:fs';
import {join} from 'node:path';
import {forEachBundleShard, shardsForBundle, SMOKE_PLAY_BUNDLE_IDS} from './smoke-play-bundles.mjs';

function usage() {
  process.stderr.write(
    'Usage: smoke-bundle-run.mjs --bundle <core|breadth|editor> --require-runtime-evidence\n',
  );
}

function parseArgs(argv) {
  /** @type {{bundle?: string, requireRuntimeEvidence?: boolean}} */
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--bundle') {
      options.bundle = value;
      index += 1;
      continue;
    }
    if (flag === '--require-runtime-evidence') {
      options.requireRuntimeEvidence = true;
      continue;
    }
    usage();
    process.exit(2);
  }
  return options;
}

function requireRuntimeEvidence(bundle) {
  let missing = false;
  forEachBundleShard(bundle, (shard) => {
    const runtimePath = join('.ci', 'smoke-shard-runtime', shard, 'runtime.json');
    try {
      accessSync(runtimePath, constants.F_OK);
    } catch {
      process.stderr.write(`Missing required smoke runtime evidence: ${runtimePath}\n`);
      missing = true;
    }
  });
  if (missing) {
    process.exit(1);
  }
}

function main() {
  const options = parseArgs(process.argv);
  if (!options.bundle) {
    usage();
    process.exit(2);
  }
  if (!SMOKE_PLAY_BUNDLE_IDS.includes(options.bundle)) {
    process.stderr.write(`unknown bundle: ${options.bundle}\n`);
    process.exit(2);
  }
  shardsForBundle(options.bundle);
  if (options.requireRuntimeEvidence) {
    requireRuntimeEvidence(options.bundle);
  }
}

if (process.argv[1]?.endsWith('smoke-bundle-run.mjs')) {
  main();
}
