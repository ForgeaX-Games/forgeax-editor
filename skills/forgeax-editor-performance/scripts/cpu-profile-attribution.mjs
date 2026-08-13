function framePath(frame) {
  try {
    return new URL(frame.url()).pathname;
  } catch {
    return '';
  }
}

export async function selectedSurfaceFrame(page, surface) {
  const prefix = surface === 'edit' ? '/editor/' : '/preview/';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const matches = page.frames().filter((frame) => framePath(frame).startsWith(prefix));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`surface ${surface} has ${matches.length} matching ${prefix} frames`);
    await page.waitForTimeout(100);
  }
  throw new Error(`surface ${surface} did not expose exactly one ${prefix} frame`);
}

function flattenFrameTree(tree, output = []) {
  output.push(tree.frame);
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, output);
  return output;
}

function sampleAttribution(profile, scriptContexts, selectedFrameId) {
  const parentById = new Map();
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentById.set(child, node.id);
  }
  const selectedIndices = [];
  let otherSamples = 0;
  let unattributedSamples = 0;
  for (let index = 0; index < (profile.samples ?? []).length; index += 1) {
    let nodeId = profile.samples[index];
    let ownerFrameId;
    while (nodeId !== undefined) {
      const scriptId = nodeById.get(nodeId)?.callFrame?.scriptId;
      if (scriptId !== undefined) {
        ownerFrameId = scriptContexts.get(String(scriptId));
        if (ownerFrameId !== undefined) break;
      }
      nodeId = parentById.get(nodeId);
    }
    if (ownerFrameId === selectedFrameId) selectedIndices.push(index);
    else if (ownerFrameId === undefined) unattributedSamples += 1;
    else otherSamples += 1;
  }
  const totalSamples = profile.samples?.length ?? 0;
  return {
    selectedIndices,
    evidence: {
      method: 'cdp-script-execution-context-frame',
      selectedSamples: selectedIndices.length,
      otherFrameSamples: otherSamples,
      unattributedSamples,
      totalSamples,
      selectedRatio: totalSamples === 0 ? 0 : selectedIndices.length / totalSamples,
    },
  };
}

export function selectAttributedSamples(profile, selectedIndices) {
  return {
    ...profile,
    samples: selectedIndices.map((index) => profile.samples[index]),
    timeDeltas: selectedIndices.map((index) => profile.timeDeltas?.[index] ?? 0),
  };
}

export async function startSurfaceProfiler(context, frame, samplingIntervalUs) {
  let client;
  let sessionScope;
  try {
    client = await context.newCDPSession(frame);
    sessionScope = 'oopif-target';
  } catch (error) {
    if (!String(error).includes('part of the parent frame')) throw error;
    client = await context.newCDPSession(frame.page());
    sessionScope = 'page-target-execution-context-filtered';
  }
  const executionContextFrames = new Map();
  const scriptContexts = new Map();
  client.on('Runtime.executionContextCreated', ({ context: created }) => {
    const frameId = created.auxData?.frameId;
    if (typeof frameId === 'string') executionContextFrames.set(created.id, frameId);
  });
  client.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    executionContextFrames.delete(executionContextId);
  });
  client.on('Debugger.scriptParsed', ({ scriptId, executionContextId }) => {
    scriptContexts.set(String(scriptId), executionContextId);
  });

  await client.send('Runtime.enable');
  await client.send('Debugger.enable');
  await client.send('Page.enable');
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: samplingIntervalUs });

  const [{ frameTree }, { targetInfo }, rootLocation] = await Promise.all([
    client.send('Page.getFrameTree'),
    client.send('Target.getTargetInfo'),
    client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }),
  ]);
  const selectedUrl = frame.url();
  const matches = flattenFrameTree(frameTree).filter((item) => item.url === selectedUrl);
  if (matches.length !== 1) {
    throw new Error(`CDP frame ownership is ambiguous for ${selectedUrl}: ${matches.length} matches`);
  }
  const selectedFrameId = matches[0].id;
  await client.send('Profiler.start');

  return {
    client,
    ownership: {
      selectedFrameId,
      selectedFrameUrl: selectedUrl,
      sessionTargetId: targetInfo.targetId,
      sessionTargetType: targetInfo.type,
      sessionRootUrl: rootLocation.result?.value ?? null,
      sessionScope,
    },
    async stop() {
      const { profile } = await client.send('Profiler.stop');
      const frameByContext = new Map(
        [...scriptContexts].map(([scriptId, contextId]) => [scriptId, executionContextFrames.get(contextId)]),
      );
      const attribution = sampleAttribution(profile, frameByContext, selectedFrameId);
      if (attribution.evidence.selectedSamples === 0) {
        throw new Error(`CPU profile has no samples attributable to selected frame ${selectedFrameId}`);
      }
      return {
        rawProfile: profile,
        profile: selectAttributedSamples(profile, attribution.selectedIndices),
        evidence: { ...this.ownership, ...attribution.evidence },
      };
    },
  };
}

export async function disableSurfaceProfiler(profiler) {
  if (profiler === undefined) return;
  await profiler.client.send('Profiler.disable').catch(() => {});
  await profiler.client.send('Debugger.disable').catch(() => {});
  await profiler.client.send('Runtime.disable').catch(() => {});
}
