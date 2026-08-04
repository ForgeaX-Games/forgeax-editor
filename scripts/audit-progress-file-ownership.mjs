#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function usage(message) {
  if (message !== undefined) console.error(`error: ${message}`);
  console.error(
    'usage: node scripts/audit-progress-file-ownership.mjs ' +
      '--progress <implement-progress.jsonl> --plan-tasks <plan-tasks.json> ' +
      '--commits <sha,sha,...>',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--progress', '--plan-tasks', '--commits'].includes(flag) || value === undefined) {
      usage(`invalid argument sequence near ${flag ?? '<end>'}`);
    }
    if (values.has(flag)) usage(`duplicate argument ${flag}`);
    values.set(flag, value);
  }
  for (const flag of ['--progress', '--plan-tasks', '--commits']) {
    if (!values.has(flag)) usage(`missing required argument ${flag}`);
  }
  const commits = values
    .get('--commits')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (commits.length === 0 || new Set(commits).size !== commits.length) {
    usage('--commits must contain unique, comma-separated SHAs');
  }
  return {
    progressPath: resolve(values.get('--progress')),
    planTasksPath: resolve(values.get('--plan-tasks')),
    commits,
  };
}

function runGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function normalizePath(value, context) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty path string`);
  }
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`${context} must be repository-relative: ${value}`);
  }
  return normalized;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse ${label} ${path}: ${error.message}`);
  }
}

function readJsonLines(path) {
  const events = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (text === '') continue;
    try {
      events.push({ line: index + 1, value: JSON.parse(text) });
    } catch (error) {
      throw new Error(`cannot parse progress line ${index + 1}: ${error.message}`);
    }
  }
  return events;
}

function loadTasks(path) {
  const document = readJson(path, 'plan tasks');
  if (!Array.isArray(document.tasks)) throw new Error('plan-tasks.json must contain tasks[]');
  const tasks = new Map();
  for (const [index, task] of document.tasks.entries()) {
    if (typeof task?.id !== 'string' || !Array.isArray(task.targetFiles)) {
      throw new Error(`plan task at index ${index} must contain id and targetFiles[]`);
    }
    if (tasks.has(task.id)) throw new Error(`duplicate plan task id ${task.id}`);
    tasks.set(task.id, {
      ...task,
      targetFiles: task.targetFiles.map((pathValue, pathIndex) =>
        normalizePath(pathValue, `${task.id}.targetFiles[${pathIndex}]`),
      ),
    });
  }
  return tasks;
}

function globPattern(target) {
  let source = '^';
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index];
    if (char === '*' && target[index + 1] === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function matchesTarget(path, targets) {
  return targets.some((target) => globPattern(target).test(path));
}

function commitMatches(recorded, fullSha) {
  return typeof recorded === 'string' && /^[0-9a-f]{7,64}$/.test(recorded) && fullSha.startsWith(recorded);
}

function changedPaths(fullSha) {
  const output = runGit([
    'show',
    '--format=',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACMRD',
    fullSha,
  ]);
  return new Set(
    output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((pathValue, index) => normalizePath(pathValue, `${fullSha}.gitShow[${index}]`)),
  );
}

function matchingTaskEvents(events, fullSha) {
  return events.filter(
    ({ value }) => value.event === 'task-completed' && commitMatches(value.commitSha, fullSha),
  );
}

function validateOutsideReasons(value, line) {
  for (const [index, outside] of (value.filesOutsideTargets ?? []).entries()) {
    if (typeof outside?.reason !== 'string' || outside.reason.trim() === '') {
      throw new Error(
        `progress line ${line} filesOutsideTargets[${index}] has a missing or empty reason`,
      );
    }
  }
}

function declaredChangedFiles(taskEvents, fullSha) {
  const files = new Set();
  for (const { line, value } of taskEvents) {
    if (!Array.isArray(value.changedFiles)) {
      throw new Error(`progress line ${line} for ${fullSha} must contain changedFiles[]`);
    }
    for (const [index, pathValue] of value.changedFiles.entries()) {
      files.add(normalizePath(pathValue, `progress line ${line} changedFiles[${index}]`));
    }
    validateOutsideReasons(value, line);
  }
  return files;
}

function collectAuditEntries(events, fullSha) {
  const entries = [];
  for (const { line, value } of events) {
    if (!['scope-audit', 'm3-scope-audit'].includes(value.event)) continue;
    for (const [index, entry] of (value.entries ?? []).entries()) {
      if (!commitMatches(entry?.commitSha, fullSha)) continue;
      entries.push({ ...entry, line, index });
    }
  }
  return entries;
}

function validateAuditEntry(entry, fullSha, actualPaths, sourceEvents, tasks) {
  const context = `scope-audit line ${entry.line} entries[${entry.index}]`;
  const path = normalizePath(entry.path, `${context}.path`);
  if (!actualPaths.has(path)) throw new Error(`${context} references ${path}, absent from git show ${fullSha}`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    throw new Error(`${context} has a missing or empty outside-target reason`);
  }
  const source = sourceEvents.find(({ value }) => value.taskId === entry.taskId);
  if (source === undefined) {
    throw new Error(`${context}.taskId ${entry.taskId} is not a task-completed owner for ${fullSha}`);
  }
  if (!(source.value.changedFiles ?? []).map((value) => normalizePath(value, context)).includes(path)) {
    throw new Error(`${context} path ${path} is not declared by source task ${entry.taskId}`);
  }
  const owner = tasks.get(entry.owner);
  if (owner === undefined) throw new Error(`${context}.owner references unknown task ${entry.owner}`);
  if (!['target', 'outside-target'].includes(entry.disposition)) {
    throw new Error(`${context}.disposition must be target or outside-target`);
  }
  const inTarget = matchesTarget(path, owner.targetFiles);
  if (entry.disposition === 'target' && !inTarget) {
    throw new Error(`${context}: ${path} is not in ${entry.owner}.targetFiles`);
  }
  if (entry.disposition === 'outside-target' && inTarget) {
    throw new Error(`${context}: ${path} is already in ${entry.owner}.targetFiles; use target`);
  }
  return { path, disposition: entry.disposition, owner: entry.owner };
}

function compareSets(actual, declared, fullSha) {
  const missing = [...actual].filter((path) => !declared.has(path));
  const extra = [...declared].filter((path) => !actual.has(path));
  if (missing.length || extra.length) {
    const details = [
      missing.length ? `missing from progress changedFiles: ${missing.join(', ')}` : '',
      extra.length ? `not present in git show: ${extra.join(', ')}` : '',
    ].filter(Boolean);
    throw new Error(`${fullSha} progress/git changed-file mismatch; ${details.join('; ')}`);
  }
}

function auditCommit(inputSha, events, tasks) {
  const fullSha = runGit(['rev-parse', '--verify', `${inputSha}^{commit}`]);
  const actualPaths = changedPaths(fullSha);
  if (actualPaths.size === 0) throw new Error(`${fullSha} has no changed paths to audit`);
  const sourceEvents = matchingTaskEvents(events, fullSha);
  if (sourceEvents.length === 0) throw new Error(`${fullSha} has no matching task-completed event`);
  compareSets(actualPaths, declaredChangedFiles(sourceEvents, fullSha), fullSha);

  const rawEntries = collectAuditEntries(events, fullSha);
  if (rawEntries.length === 0) {
    throw new Error(`${fullSha} has no enhanced scope-audit entries; append taskId/commitSha/path/owner/disposition/reason records`);
  }
  const records = rawEntries.map((entry) =>
    validateAuditEntry(entry, fullSha, actualPaths, sourceEvents, tasks),
  );
  const counts = new Map();
  for (const record of records) counts.set(record.path, (counts.get(record.path) ?? 0) + 1);
  const missing = [...actualPaths].filter((path) => !counts.has(path));
  const duplicates = [...counts].filter(([, count]) => count !== 1).map(([path]) => path);
  if (missing.length || duplicates.length) {
    throw new Error(
      `${fullSha} scope coverage mismatch; ` +
        `${missing.length ? `unaccounted: ${missing.join(', ')}` : ''}` +
        `${missing.length && duplicates.length ? '; ' : ''}` +
        `${duplicates.length ? `multiply owned: ${duplicates.join(', ')}` : ''}`,
    );
  }
  const targetCount = records.filter((record) => record.disposition === 'target').length;
  return { fullSha, changedFiles: actualPaths.size, targetCount, outsideTargetCount: records.length - targetCount };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.planTasksPath);
  const events = readJsonLines(args.progressPath);
  const results = args.commits.map((sha) => auditCommit(sha, events, tasks));
  for (const result of results) {
    console.log(
      `PASS ${result.fullSha} changed=${result.changedFiles} ` +
        `target=${result.targetCount} outside=${result.outsideTargetCount}`,
    );
  }
  console.log(`PASS ownership audit: ${results.length} commits`);
}

try {
  main();
} catch (error) {
  console.error(`ownership audit failed: ${error.message}`);
  process.exit(1);
}
