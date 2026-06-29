import type {
  ApplyResult,
  EditorCommand,
  EditSession,
  EntityId,
  EntityNode,
} from './types';

// createEditSession (the former `createDocument`) lives in edit-session.ts next
// to the EditSession factory + engine-POD projection; re-export it here so the
// long-standing `./document` import path keeps resolving.
export { createEditSession } from './edit-session';

function clone<T>(v: T): T {
  return structuredClone(v);
}

/**
 * Apply one command to `session` in place and return its inverse (for Undo) or a
 * structured error. The inverse is itself a legal EditorCommand — so Undo/Redo
 * needs no special machinery (it is "just dispatch another command").
 *
 * `session` is the editor's EditSession (plan-strategy D-6): mutations land on
 * its authoring `entities`/`order`/`nextLocalId`; the engine `SceneAsset`
 * projection (`session.asset`) is a fresh derived getter and needs no explicit
 * rebuild here.
 */
export function applyCommand(doc: EditSession, cmd: EditorCommand): ApplyResult {
  switch (cmd.kind) {
    case 'spawnEntity': {
      // Honor a provided _id so undo→redo / destroy-inverse restore the SAME id
      // (stable references matter for deixis handles & ledger replay). Otherwise
      // allocate a fresh id.
      const reuse = cmd._id !== undefined && !doc.entities[cmd._id];
      const id = reuse ? (cmd._id as EntityId) : doc.nextLocalId++;
      if (reuse && id >= doc.nextLocalId) doc.nextLocalId = id + 1;
      const parent = cmd.parent ?? null;
      if (parent !== null && !doc.entities[parent]) {
        if (!reuse) doc.nextLocalId--; // roll back id reservation
        return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${parent} does not exist` } };
      }
      const node: EntityNode = {
        id,
        name: cmd.name ?? `Entity ${id}`,
        parent,
        components: clone(cmd.components ?? {}),
        ...(cmd.source ? { source: clone(cmd.source) } : {}),
      };
      doc.entities[id] = node;
      doc.order.push(id);
      cmd._id = id;
      return { ok: true, inverse: { kind: 'destroyEntity', entity: id } };
    }

    case 'destroyEntity': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const snapshot = clone(node);
      delete doc.entities[cmd.entity];
      doc.order = doc.order.filter((e) => e !== cmd.entity);
      return {
        ok: true,
        inverse: {
          kind: 'spawnEntity',
          name: snapshot.name,
          parent: snapshot.parent,
          components: snapshot.components,
          ...(snapshot.source ? { source: snapshot.source } : {}),
          _id: snapshot.id,
        },
      };
    }

    case 'rename': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const before = node.name;
      node.name = cmd.name;
      return { ok: true, inverse: { kind: 'rename', entity: cmd.entity, name: before } };
    }

    case 'reparent': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      if (cmd.parent !== null && !doc.entities[cmd.parent]) {
        return { ok: false, error: { code: 'INVALID_PARENT', hint: `parent ${cmd.parent} not found` } };
      }
      if (cmd.parent === cmd.entity) {
        return { ok: false, error: { code: 'INVALID_PARENT', hint: 'cannot parent an entity to itself' } };
      }
      const before = node.parent;
      node.parent = cmd.parent;
      return { ok: true, inverse: { kind: 'reparent', entity: cmd.entity, parent: before } };
    }

    case 'setComponent': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const current = node.components[cmd.component];
      if (current === undefined) {
        return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
      }
      const before = clone(current) as Record<string, unknown>;
      node.components[cmd.component] = { ...(current as Record<string, unknown>), ...cmd.patch };
      // inverse restores only the keys we touched
      const restore: Record<string, unknown> = {};
      for (const k of Object.keys(cmd.patch)) restore[k] = (before as Record<string, unknown>)[k];
      return { ok: true, inverse: { kind: 'setComponent', entity: cmd.entity, component: cmd.component, patch: restore } };
    }

    case 'addComponent': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      if (node.components[cmd.component] !== undefined) {
        return { ok: false, error: { code: 'COMPONENT_EXISTS', hint: `component ${cmd.component} already on entity ${cmd.entity}` } };
      }
      node.components[cmd.component] = clone(cmd.value);
      return { ok: true, inverse: { kind: 'removeComponent', entity: cmd.entity, component: cmd.component } };
    }

    case 'removeComponent': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const current = node.components[cmd.component];
      if (current === undefined) {
        return { ok: false, error: { code: 'NO_SUCH_COMPONENT', hint: `component ${cmd.component} not on entity ${cmd.entity}` } };
      }
      const value = clone(current);
      delete node.components[cmd.component];
      return { ok: true, inverse: { kind: 'addComponent', entity: cmd.entity, component: cmd.component, value } };
    }

    case 'setHidden': {
      const node = doc.entities[cmd.entity];
      if (!node) return { ok: false, error: { code: 'NO_SUCH_ENTITY', hint: `entity ${cmd.entity} not found` } };
      const before = node.hidden ?? false;
      node.hidden = cmd.hidden;
      return { ok: true, inverse: { kind: 'setHidden', entity: cmd.entity, hidden: before } };
    }

    case 'transaction': {
      if (cmd.commands.length === 0) {
        return { ok: false, error: { code: 'EMPTY_TRANSACTION', hint: 'transaction has no commands' } };
      }
      const inverses: EditorCommand[] = [];
      for (const sub of cmd.commands) {
        const r = applyCommand(doc, sub);
        if (!r.ok) {
          // roll back already-applied sub-commands in reverse
          for (let i = inverses.length - 1; i >= 0; i--) applyCommand(doc, inverses[i]!);
          return r;
        }
        inverses.push(r.inverse);
      }
      inverses.reverse();
      return { ok: true, inverse: { kind: 'transaction', label: `undo ${cmd.label}`, commands: inverses } };
    }
  }
}

/** Stable child list for an entity (or root when parent === null). */
export function childrenOf(doc: EditSession, parent: EntityId | null): EntityId[] {
  return doc.order.filter((id) => doc.entities[id]?.parent === parent);
}

/**
 * True if `candidate` is `node` itself or anywhere in its subtree. Used to block
 * a reparent that would put a node inside its own subtree (cycle / orphan).
 */
export function isSelfOrDescendant(doc: EditSession, node: EntityId, candidate: EntityId): boolean {
  if (node === candidate) return true;
  for (const c of childrenOf(doc, node)) {
    if (isSelfOrDescendant(doc, c, candidate)) return true;
  }
  return false;
}
