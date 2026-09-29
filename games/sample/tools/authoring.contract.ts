// Cold discovery reads only declarations; producer code loads on invocation.
export default {
  schemaVersion: '1.0.0',
  commands: [
    { id: 'authoring.snapshot.read', title: 'Read authoring snapshot', summary: 'Reads a Project-owned source snapshot.', exportName: 'readAuthoringSnapshot' },
    { id: 'material.author.update', title: 'Update material source', summary: 'Validates and CAS-writes material source.', exportName: 'updateMaterial' },
    { id: 'mesh.author.update', title: 'Update mesh defaults', summary: 'Validates and CAS-writes mesh material slot defaults.', exportName: 'updateMesh' },
    { id: 'vfx.author.update', title: 'Update VFX source', summary: 'Validates, CAS-writes, and republishes VFX source.', exportName: 'updateVfx' },
  ].map((command) => ({ ...command, realm: 'build', executor: './authoring.plugin.ts', argsSchema: '{"type":"object"}' })),
};
