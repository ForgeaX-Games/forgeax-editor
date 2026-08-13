// Read-only active default-branch ruleset discovery.
//
// GitHub's ruleset list response does not reliably include conditions, so list
// candidates are only a bounded input set. Selection is made from every
// candidate detail and succeeds only when exactly one detail proves the active
// default-branch scope.

import { extractRequiredContexts } from './ci-baseline.mjs';

function issue(code, expected, observed, hint) {
  return { code, expected, observed, hint };
}

function failure(error) {
  return { ok: false, errors: [error] };
}

function unavailable(stage, error) {
  return failure(issue(
    'live-ruleset-unavailable',
    `readable live ruleset ${stage} evidence`,
    error?.message ?? String(error),
    'Keep the admission read-only and fail closed when GitHub policy evidence cannot be read.',
  ));
}

function flattenListPages(value) {
  if (Array.isArray(value)) {
    return value.flatMap((page) => {
      if (Array.isArray(page)) return flattenListPages(page);
      if (Array.isArray(page?.rulesets)) return page.rulesets;
      return page;
    });
  }
  if (Array.isArray(value?.rulesets)) return value.rulesets;
  return [];
}

function idOf(value) {
  return value?.id === undefined || value?.id === null ? null : String(value.id);
}

function defaultBranchRef(detail, defaultBranch) {
  const includes = detail?.conditions?.ref_name?.include;
  if (!Array.isArray(includes)) return false;
  return includes.some((ref) => ref === '~DEFAULT_BRANCH' || ref === `refs/heads/${defaultBranch}` || ref === defaultBranch);
}

function detailEntries(details) {
  if (Array.isArray(details)) {
    return details.map((entry) => ({id: idOf(entry?.detail ?? entry), detail: entry?.detail ?? entry, error: entry?.error}));
  }
  if (details && typeof details === 'object') {
    return Object.entries(details).map(([id, value]) => ({id: String(id), detail: value?.detail ?? value, error: value?.error}));
  }
  return [];
}

/**
 * Select from already-read list/detail packets. This pure boundary is used by
 * focused tests and keeps API transport separate from policy decisions.
 */
export function selectActiveDefaultBranchRuleset({candidates, details, defaultBranch = 'main'} = {}) {
  const list = flattenListPages(candidates);
  if (list.length === 0) {
    return failure(issue(
      'live-ruleset-list-empty',
      'at least one active branch ruleset candidate',
      list,
      'Read the repository ruleset list before deciding that no default-branch policy exists.',
    ));
  }
  const candidateIds = list.map(idOf);
  if (candidateIds.some((id) => id === null)) {
    return failure(issue('live-ruleset-list-invalid', 'every ruleset candidate has an id', list, 'Reject malformed list evidence instead of guessing a policy identity.'));
  }
  const duplicateIds = candidateIds.filter((id, index) => candidateIds.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    return failure(issue('live-ruleset-list-ambiguous', 'one list candidate per ruleset id', [...new Set(duplicateIds)], 'Reject duplicate list identities before reading policy detail.'));
  }
  const candidatesToDetail = list.filter((candidate) => candidate.enforcement === 'active' && candidate.target === 'branch');
  if (candidatesToDetail.length === 0) {
    return failure(issue('live-ruleset-list-empty', 'an active branch ruleset candidate', list, 'Filter only active branch rulesets and fail closed when none are available.'));
  }

  const entries = detailEntries(details);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const detailFailures = [];
  const qualifying = [];
  for (const candidate of candidatesToDetail) {
    const id = idOf(candidate);
    const entry = byId.get(id);
    if (!entry || entry.error) {
      detailFailures.push({id, error: entry?.error?.message ?? entry?.error ?? 'detail missing'});
      continue;
    }
    const detailId = idOf(entry.detail);
    if (detailId !== id) {
      return failure(issue('live-ruleset-list-detail-mismatch', id, detailId, 'Bind each list candidate to detail with the same immutable ruleset id.'));
    }
    if (entry.detail?.enforcement === 'active' && entry.detail?.target === 'branch' && defaultBranchRef(entry.detail, defaultBranch)) {
      qualifying.push(entry.detail);
    }
  }
  if (detailFailures.length > 0) {
    return failure(issue(
      'live-ruleset-detail-unavailable',
      'readable detail for every active branch candidate',
      detailFailures,
      'Do not discard an unreadable candidate; its scope is unknown and admission must remain red.',
    ));
  }
  if (qualifying.length === 0) {
    return failure(issue(
      'live-ruleset-default-branch-missing',
      `one active branch ruleset scoped to ${defaultBranch}`,
      candidatesToDetail.map((candidate) => idOf(candidate)),
      'Read candidate detail and require an explicit default-branch ref condition.',
    ));
  }
  if (qualifying.length !== 1) {
    return failure(issue(
      'live-ruleset-ambiguous',
      'exactly one active default-branch ruleset',
      qualifying.map((detail) => idOf(detail)),
      'Do not select by name or order when multiple active default-branch rulesets qualify.',
    ));
  }
  return {
    ok: true,
    errors: [],
    ruleset: qualifying[0],
    selection: {
      defaultBranch,
      candidateIds: candidatesToDetail.map((candidate) => idOf(candidate)),
      selectedId: idOf(qualifying[0]),
      detailRead: true,
    },
  };
}

function readInputs(readRepository, readRulesets, readDetail) {
  const repository = readRepository();
  const defaultBranch = repository?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
    return failure(issue('live-ruleset-repository-invalid', 'repository.default_branch', repository?.default_branch ?? null, 'Read the repository metadata before evaluating default-branch ruleset scope.'));
  }
  const candidates = readRulesets();
  const list = flattenListPages(candidates);
  const activeBranchCandidates = list.filter((candidate) => candidate?.enforcement === 'active' && candidate?.target === 'branch');
  const details = activeBranchCandidates.map((candidate) => {
    try {
      return {id: idOf(candidate), detail: readDetail(idOf(candidate))};
    } catch (error) {
      return {id: idOf(candidate), error};
    }
  });
  return selectActiveDefaultBranchRuleset({candidates: list, details, defaultBranch});
}

export function discoverLiveRulesetSync({readRepository, readRulesets, readDetail} = {}) {
  if (typeof readRepository !== 'function' || typeof readRulesets !== 'function' || typeof readDetail !== 'function') {
    return failure(issue('live-ruleset-reader-invalid', 'repository, list, and detail readers', 'missing', 'Provide all read-only API readers before live policy admission.'));
  }
  try {
    return readInputs(readRepository, readRulesets, readDetail);
  } catch (error) {
    return unavailable('API', error);
  }
}

export async function discoverLiveRuleset({readRepository, readRulesets, readDetail} = {}) {
  if (typeof readRepository !== 'function' || typeof readRulesets !== 'function' || typeof readDetail !== 'function') {
    return failure(issue('live-ruleset-reader-invalid', 'repository, list, and detail readers', 'missing', 'Provide all read-only API readers before live policy admission.'));
  }
  try {
    const repository = await readRepository();
    const defaultBranch = repository?.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) {
      return failure(issue('live-ruleset-repository-invalid', 'repository.default_branch', repository?.default_branch ?? null, 'Read the repository metadata before evaluating default-branch ruleset scope.'));
    }
    const candidates = await readRulesets();
    const list = flattenListPages(candidates);
    const activeBranchCandidates = list.filter((candidate) => candidate?.enforcement === 'active' && candidate?.target === 'branch');
    const details = [];
    for (const candidate of activeBranchCandidates) {
      try {
        details.push({id: idOf(candidate), detail: await readDetail(idOf(candidate))});
      } catch (error) {
        details.push({id: idOf(candidate), error});
      }
    }
    return selectActiveDefaultBranchRuleset({candidates: list, details, defaultBranch});
  } catch (error) {
    return unavailable('API', error);
  }
}

export function requiredContextNamesFromRuleset(ruleset) {
  if (Array.isArray(ruleset?.requiredContexts)) return ruleset.requiredContexts.map((context) => typeof context === 'string' ? context : context?.context ?? context?.name).filter(Boolean);
  return extractRequiredContexts(ruleset).map((context) => context.context);
}
