export const POST_MERGE_LABELS = ['post-merge', 'ci-failure', 'sla-24h'];
export const POST_MERGE_MARKER = '<!-- forgeax-post-merge-monitor -->';

export function extractIssueMergeSha(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/\*\*merge sha\*\*: `([^`]+)`/);
  return match ? match[1] : null;
}

export function isTrackedIssue(issue) {
  const labels = (issue.labels ?? []).map((label) =>
    typeof label === 'string' ? label : label?.name,
  );
  return labels.includes('post-merge') ||
    (typeof issue.body === 'string' && issue.body.includes(POST_MERGE_MARKER));
}

export function findTrackedOpenIssues(openIssues) {
  return openIssues.filter(isTrackedIssue);
}

export function findMatchingOpenIssues(headSha, issues) {
  const sentinel = `**merge sha**: \`${headSha}\``;
  return issues.filter((issue) => issue.body?.includes(sentinel));
}

export function buildDedupComment(workflowRun, classification) {
  return [
    `duplicate red detected on same head_sha \`${workflowRun.head_sha}\``,
    '',
    `**ci run url**: ${workflowRun.html_url}`,
    `**classification**: \`${classification}\``,
  ].join('\n');
}

export function buildFailureIssue(workflowRun, monitorUrl, { classification, code, failureClass }) {
  const title = `[post-merge] 2026-08-19 CI ${workflowRun.conclusion ?? 'non-success'} on main`;
  const body = [
    POST_MERGE_MARKER,
    `Post-merge CI evidence for main is **${workflowRun.conclusion ?? 'non-success'}**.`,
    '',
    `**merge sha**: \`${workflowRun.head_sha}\``,
    `**ci run url**: ${workflowRun.html_url}`,
    `**monitor run url**: ${monitorUrl}`,
    `**classification**: \`${classification}\``,
    `**failure class**: \`${failureClass || 'unknown'}\``,
    `**code**: \`${code}\``,
  ].join('\n');
  return { title, body, labels: POST_MERGE_LABELS };
}

export function buildEvidenceComment(workflowRun, issueMergeSha, isoTimestamp) {
  const scenario = issueMergeSha === workflowRun.head_sha ? 'sha-rerun-green' : 'sha-progressed';
  const body = [
    'Auto-closed by post-merge-ci-monitor: main CI evidence turned green.',
    '',
    `**ci run url**: ${workflowRun.html_url}`,
    `**timestamp**: ${isoTimestamp}`,
    `**scenario**: ${scenario}`,
  ].join('\n');
  return { scenario, body };
}
