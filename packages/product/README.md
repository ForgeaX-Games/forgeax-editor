# ForgeaX editor product contract

`@forgeax/editor-product` is the UI-free contract and capability index shared
by the editor UI, Bun hosts, and runtime adapters. The capability registry is
the single source of truth. This package does not import React, an engine
World, a browser host, or a producer parser.

## Shortest successful path

The intended AI path is `discover -> preflight -> dispatch`. For save, dispatch returns an accepted
run projection; completion must be read by the same `requestId`:

```ts
import {
  createEditorProduct,
  createTransportService,
  TRANSPORT_PROTOCOL_VERSION,
} from '@forgeax/editor-product';

const product = createEditorProduct({ capabilityRegistry });
const facts = product.discover();
const capability = product.describeCapability('editor.listOps');

// Preflight uses capability.availability, inputSchema, permission, and
// confirmation. Dispatch is performed by the connected host adapter through
// the same effect owner used by the editor UI.
if (facts.availability.available && capability?.availability.available) {
  // The host adapter dispatches the validated subject.verb request here.
}

const save = await service.handle({
  jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'save-1',
  correlationId: 'save-request-1', method: 'run.dispatch',
  params: { operationId: 'saveDocToDisk', input: { requestId: 'save-request-1' } },
});
// Follow with run.get/run.wait using params.requestId, not a private UI flag.
```

Do not copy capability ids into an AI-only table. Call `discover()` or
`discoverCapabilities()` and use `describeCapability()` for one id. The
`subject.verb` id is canonical, and verbs use camelCase names.

## Capability index

Each `CapabilityDescriptor` is executor-free transport data. Its important
fields are:

- `id`: canonical `subject.verb` name.
- `kind`: operation, query, run, or workflow.
- `inputSchema` and `outputSchema`: machine-readable parameter and result
  shapes used before dispatch.
- `availability` and `availabilityByHost`: explicit availability facts.
- `permission`, `confirmation`, `cancellation`, and `retry`: policy facts.
- `preconditions` and `recoveryActions`: validation and recovery guidance.

The `CapabilityRegistry` derives the manifest and applies discovery filters.
Host adapters may attach an executor during registration, but a published
descriptor never exposes that closure.

## Error contract

Use `CommandError.code` for branching. Use `subjectRef`, `expected`,
`current`, `retryable`, `confirmation`, and `recoveryActions` for structured
handling. `hint` and `message` are explanatory text and must not be parsed as
protocol fields. `createCommandError()` freezes the result and its recovery
action list; `isCommandError()` narrows unknown transport data.

## Public entry points

- `createEditorProduct()` creates the shared facade.
- `discover()` returns the contract, manifest, and product availability.
- `discoverCapabilities()` lists the derived capability index.
- `describeCapability()` resolves one canonical id for preflight.
- `capabilityId()` builds a canonical `subject.verb` id.
- `createCommandError()` and `unavailable()` create structured failures.

Later run and transport layers consume these same contracts. They must keep
the registry, error shape, and host adapter boundaries intact.

## Canonical host wiring

The production transport uses the same product, runtime, workspace, lifecycle,
journal, and workflow owners as the editor UI:

```ts
const service = createTransportService({
  product: createEditorProduct({ capabilityRegistry }),
  runtime, assetWorkspace, assetLifecycle, assetRestore, journal,
  workflowCoordinator, workflowRecipes,
});
const response = await service.handle({
  jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'discover-1',
  correlationId: 'trace-1', method: 'discover', params: {},
});
```

Disconnected owners remain visible as structured `executor-unavailable`
facts; clients must not substitute a private host adapter.

## Compatibility matrix

| Carrier | Discovery | Run journal | Workflow recovery | Notes |
|:--|:--:|:--:|:--:|:--|
| Bun host | yes | yes | yes | `createTransportService({ product, journal })` |
| UI-free test host | yes | yes | yes | Use the same registry and adapter fixture as the product conformance tests. |
| Browser editor host | yes | host-provided | host-provided | The browser bridge must expose the typed transport carrier; it must not invent a second capability list. |

The wire version is `TRANSPORT_PROTOCOL_VERSION`. A client should call
`discover` before dispatch and branch on `availabilityByHost` rather than
assuming that a capability is available in every carrier.

## Canonical text request/response

Requests and responses are newline-delimited JSON objects. The same request
shape is used by the Bun carrier and the editor bridge:

```json
{"jsonrpc":"2.0","version":"editor-transport/v1","id":"req-1","correlationId":"trace-1","method":"discover","params":{}}
{"jsonrpc":"2.0","version":"editor-transport/v1","id":"req-1","correlationId":"trace-1","result":{"protocolVersion":"editor-transport/v1","manifest":{"productId":"@forgeax/editor-product"},"capabilityManifest":{"generatedFrom":"capability-registry"},"availability":{"available":true},"runtime":{"blocking":false},"methods":["discover","transport.describe","query","asset.snapshot","asset.observe","asset.reconcile","asset.preflight","asset.mutate","asset.restore","run.dispatch","run.get","run.wait","run.list","run.listEvents","run.retry","run.cancel","run.reconcile","workflow.start","workflow.get","workflow.recover","workflow.retry","workflow.listRecipes","save","reopen","runtime.play","runtime.stop","runtime.query","runtime.fixedStep","runtime.dispose","runtime.capture","runtime.reveal"]}}
```

For a mutating call, send the operation through `run.dispatch` only after
discovery and preflight. Every response is either `result` or structured
`error`; never parse the human-readable `hint` as a protocol field.

## Recovery decision table

| Fact | First action | If it still fails |
|:--|:--|:--|
| Unknown or expired `runId` | call `run.list` / `discover` | start a new request with a new idempotency key |
| Failed retryable run | call `run.retry` with the recorded input | inspect `error.recoveryActions` and ask for confirmation if required |
| Detached workflow after restart | call `workflow.get`, then `workflow.recover` | re-submit the durable recipe identity; do not replay an unknown recipe |
| Asset conflict or quarantine | call `asset.observe` / `asset.reconcile` and inspect recovery intents | call `asset.restore` through the connected recovery owner, then dispatch the mutation |
| Scope or permission error | call `transport.describe` / `discover` | select an allowed scope or request the missing permission |

## Troubleshooting

- `protocol-bad-version`: use the version returned by `discover`; do not
  silently downgrade a request.
- `executor-unavailable`: the typed carrier is alive but no host executor is
  connected. Reconnect the host and call `discover` again.
- `run-not-found` or `run-expired`: the journal no longer has the requested
  snapshot. Start a new idempotent run and retain the returned `runId`.
- `confirmation-required`: show the structured confirmation token to the
  user before retrying; do not manufacture a token in an AI-only registry.
- `scope-mismatch`: inspect the `scope` and `recoveryActions` fields and
  select a scope explicitly. A failed scope check must not mutate the scene.
