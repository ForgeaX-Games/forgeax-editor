# Editor Headless Operation Architecture

> 日期：2026-07-17  
> 状态：规划建议  
> 范围：editor state / logic / UI / AI 操作入口的目标分层。

---

## 0. 结论

Editor 应被视为一个 **headless operation system**，React DOM 只是其中一个 adapter。

> [!IMPORTANT]
> 人类 UI 和 AI 必须通过同一套 operation layer 操作 editor。不要让 UI 直接改 state，而 AI 走另一套 server API。

一句话：

```txt
UI, AI, CLI, server RPC are adapters.
The editor operation layer is the product.
```

---

## 1. 目标层级

```txt
Presentation / Adapters
  React panels, viewport chrome, keyboard, command palette, AI tools, CLI, server RPC
    |
    | dispatch / query
    v
Operation / Application Layer
  gateway.dispatch(op), query APIs, transactions, undo, ledger, permissions, tool metadata
    |
    | calls domain services
    v
Domain / Logic Layer
  scene ops, entity ops, component validation, hierarchy rules, asset rules
    |
    | mutates through controlled ports
    v
State Layer
  authored scene state, session state, ephemeral state, ECS world, selection, undo stack
    |
    | backed by infrastructure
    v
Infrastructure Adapters
  file IO, server transport, asset registry, engine runtime, renderer, browser storage
```

---

## 2. Current Package Mapping

| Target layer | Current package / module | Target role |
|:--|:--|:--|
| Presentation / adapters | `@forgeax/editor-panels` | Business UI such as Hierarchy / Inspector / Assets |
| Presentation / adapters | `@forgeax/editor-edit-runtime` | Viewport, browser lifecycle, Play/Edit runtime adapter |
| Presentation / adapters | future `@forgeax/editor-ui` | Domain-free UI primitives |
| Operation / application | `@forgeax/editor-core` gateway / ops | Single dispatch/query surface |
| Domain / logic | `@forgeax/editor-core` scene/session modules | Validated editor behavior |
| State | `@forgeax/editor-core` stores + document/session state | Authored/session state |
| Infrastructure | engine packages, platform IO, server proxy | Runtime and persistence ports |

---

## 3. State Categories

| State kind | Examples | Mutation path | Persisted? | AI-facing? |
|:--|:--|:--|:--:|:--:|
| Authored state | entities, components, hierarchy, asset refs | document ops | ✅ | ✅ |
| Session state | selection, active tool, viewport mode, play/edit mode | session ops | usually no | selectively |
| Ephemeral UI state | hover, draft input text, popover open, drag preview | React/local state | ❌ | ❌ |

Rules:

- Authored state changes must have undo / ledger / save semantics.
- Session state changes should still be dispatchable when they matter to collaboration or AI control.
- Ephemeral UI state stays local and should not become an AI capability.

---

## 4. Read / Write Split

The editor should use a CQRS-style split:

```txt
Read path:
  UI / AI / CLI / server
    -> query / selector / read model
    -> State Layer

Write path:
  UI / AI / CLI / server
    -> operation adapter
    -> EditGateway.dispatch(op)
    -> applier / domain logic
    -> State Layer
```

Rules:

- UI does not need to read state through an operation.
- UI must write state through an operation.
- AI should read through the same query/read surface, not through DOM inspection.
- AI must write through the same operation surface, not through a parallel server API.
- The Operation / Application Layer does not own a duplicate state model. It owns dispatch, validation, undo, ledger, operation metadata, and routing.
- The State Layer remains the source of truth: engine `World` for authored scene state, editor session stores for session state, and local React state only for ephemeral UI drafts.

Do not build this:

```txt
EditGateway entity tree
engine World entity tree
Hierarchy local entity tree
AI-side scene copy
```

Build this:

```txt
State Layer is SSOT
query/selectors derive readable views
operations are the only write path
```

---

## 5. One Capability, Many Entrypoints

Adding an entity should have one implementation:

```txt
Hierarchy button
Command palette
Keyboard shortcut
AI tool
Server RPC
CLI
  |
  v
createEntity operation
  |
  v
domain logic
  |
  v
controlled state mutation
```

Bad split:

```txt
Hierarchy button -> world.spawn()
AI tool          -> /api/add-node implemented in server
CLI              -> separate script mutates scene JSON
```

Good split:

```txt
Hierarchy button -> dispatch({ kind: 'createEntity' })
AI tool          -> dispatch({ kind: 'createEntity' })
Server RPC       -> forward dispatch({ kind: 'createEntity' })
CLI              -> dispatch({ kind: 'createEntity' })
```

---

## 6. Operation Shape

Example operation:

```ts
type CreateEntityOp = {
  kind: 'createEntity';
  parent?: EntityHandle | null;
  name?: string;
  components?: ComponentPatch[];
};
```

Handler shape:

```ts
registerOp('createEntity', {
  title: 'Create entity',
  description: 'Create a new scene entity',
  schema: CreateEntitySchema,
  exposure: {
    human: true,
    ai: true,
    commandPalette: true,
  },

  apply(ctx, op) {
    const entity = ctx.engine.spawnEntity({
      parent: op.parent ?? null,
      name: op.name ?? 'Entity',
      components: op.components ?? [],
    });

    return {
      ok: true,
      entity,
      inverse: { kind: 'deleteEntity', entity },
      ledger: { label: `Create ${op.name ?? 'Entity'}` },
    };
  },
});
```

> [!NOTE]
> The schema, title, description, permission metadata, undo inverse, and ledger label should live with the operation. Do not duplicate those fields in AI tool definitions or UI button handlers.

---

## 7. AI as a First-class User

AI should consume the same operation registry that human UI uses.

```txt
Operation registry
  -> UI buttons
  -> command palette
  -> keyboard router
  -> AI tool manifest
  -> server RPC schema
  -> audit ledger
```

AI-friendly requirements:

| Requirement | Why it matters |
|:--|:--|
| Every operation has a schema | AI can produce validated arguments |
| Every operation has a title and description | AI can select the right tool |
| Every failure is structured | AI can recover or ask for missing input |
| Every authored mutation is ledgered | Human can inspect what AI did |
| Undo/inverse exists where possible | AI and human mistakes are recoverable |
| Queries are explicit | AI can inspect before mutating |

---

## 8. Server Boundary

Server should be transport and coordination, not the owner of editor business logic.

| Server role | Allowed? | Example |
|:--|:--:|:--|
| Auth/session validation | ✅ | "Can this client dispatch this op?" |
| Transport adapter | ✅ | `POST /api/editor/dispatch` forwards op |
| Persistence coordination | ✅ | Save/load via injected backend port |
| Reimplement create/reparent/set-component logic | ❌ | Server-side `/api/add-node` that mutates scene differently |
| Direct scene JSON surgery for AI | ❌ | Bypasses undo, schema, gateway, ledger |

Target shape:

```txt
POST /api/editor/dispatch
  -> validate session/auth
  -> forward to operation layer
  -> return structured result
  -> stream ledger/event update
```

---

## 9. UI Layer Rules

Business UI should do only:

```txt
read state/query snapshot
render
dispatch operation
hold ephemeral local state
```

Examples:

| UI action | Correct behavior |
|:--|:--|
| Hierarchy "Add child" | `gateway.dispatch({ kind: 'createEntity', parent })` |
| Inspector field edit | `gateway.dispatch({ kind: 'setComponent', entity, component, patch })` or begin/update/commit for continuous gestures |
| Drag hierarchy row | `gateway.begin(...) -> update(...) -> commit(...)` |
| Toggle play mode | session op |
| Input draft text before commit | local React state |

---

## 10. Operation Domains

| Domain | Mutates | Undo | Ledger | Examples |
|:--|:--|:--:|:--:|:--|
| Document op | authored scene state | ✅ | ✅ | create entity, set component, reparent, delete |
| Session op | editor session state | ❌ usually | ✅ | play, stop, set display, set gizmo |
| Transient op | temporary runtime state | ❌ | ❌ | hover preview, drag preview |
| Query | reads state | ❌ | optional | list components, inspect entity, search assets |

> [!IMPORTANT]
> The operation domain should be structural, not a hand-written label. Where an op is registered determines whether it is document/session/transient.

---

## 11. Migration Plan

- [ ] M1: Document existing operation registry and current gateway dispatch surface.
- [ ] M2: Classify current mutations into document/session/transient/query.
- [ ] M3: Move direct UI writes in `Hierarchy` / `Inspector` behind gateway operations.
- [ ] M4: Derive AI tool manifests from operation metadata instead of maintaining parallel AI APIs.
- [ ] M5: Add server dispatch transport that forwards ops instead of reimplementing editor logic.
- [ ] M6: Add structured query APIs for AI inspection before mutation.
- [ ] M7: Add lint gates for new UI direct state/world mutations outside operation handlers.

---

## 12. Design North Star

The editor is not a React app with AI bolted on.

It is:

```txt
headless editor kernel
  + operation registry
  + domain logic
  + state model
  + adapters for human UI, AI, CLI, server, and browser runtime
```

React DOM is one adapter. AI is another adapter. Both are first-class users of the same editing language.
