// Capability registration SSOT and host parity projection.

import {
  capabilityId,
  isCapabilityDescriptor,
  unavailableCapability,
  type CapabilityAvailability,
  type CapabilityDescriptor,
  type CapabilityHost,
  type CapabilityRegistration,
} from '../contracts/capability';
export type { CapabilityHost } from '../contracts/capability';
import type { CommandError } from '../contracts/error';
import {
  createCapabilityManifest,
  type CapabilityManifest,
} from '../contracts/manifest';

const DEFAULT_HOSTS: readonly CapabilityHost[] = ['bun', 'edit', 'play'];

export interface CapabilityDiscoveryOptions {
  readonly host?: CapabilityHost;
  readonly includeUnavailable?: boolean;
}

export interface HostParityReport {
  readonly hosts: readonly CapabilityHost[];
  readonly nonDisplayIdsByHost: Readonly<Record<CapabilityHost, readonly string[]>>;
  readonly nonDisplayDifferences: readonly string[];
  readonly availabilityByHost: Readonly<
    Partial<Record<CapabilityHost, Readonly<Record<string, CapabilityAvailability>>>>
  >;
}

function hostAvailability(
  registration: CapabilityRegistration,
  host: CapabilityHost | undefined,
): CapabilityAvailability {
  const declared = host === undefined
    ? registration.availability
    : registration.availabilityByHost?.[host] ?? registration.availability;
  if (!declared.available) return declared;
  if (registration.executor === undefined) {
    return unavailableCapability(
      'executor-unavailable',
      `capability "${registration.id}" has no registered executor`,
      'register an executor adapter for this capability',
    );
  }
  return declared;
}

function publicDescriptor(
  registration: CapabilityRegistration,
  host: CapabilityHost | undefined,
): CapabilityDescriptor {
  return Object.freeze({
    id: registration.id,
    kind: registration.kind,
    version: registration.version,
    subject: registration.subject,
    verb: registration.verb,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    availability: hostAvailability(registration, host),
    ...(registration.availabilityByHost === undefined
      ? {}
      : { availabilityByHost: Object.freeze({ ...registration.availabilityByHost }) }),
    ...(registration.presentationOnly === undefined
      ? {}
      : { presentationOnly: registration.presentationOnly }),
    preconditions: Object.freeze([...registration.preconditions]),
    ...(registration.permission === undefined ? {} : { permission: registration.permission }),
    ...(registration.confirmation === undefined ? {} : { confirmation: registration.confirmation }),
    ...(registration.cancellation === undefined ? {} : { cancellation: registration.cancellation }),
    ...(registration.retry === undefined ? {} : { retry: registration.retry }),
    recoveryActions: Object.freeze([...registration.recoveryActions]),
  });
}

function unavailableResult(
  descriptor: CapabilityDescriptor,
): { readonly ok: false; readonly error: CommandError } {
  return {
    ok: false,
    error: {
      code: descriptor.availability.code ?? 'executor-unavailable',
      hint: descriptor.availability.reason ?? 'capability is unavailable',
      retryable: false,
      recoveryActions: descriptor.recoveryActions,
    },
  };
}

function unknownCapabilityResult(
  id: string,
): { readonly ok: false; readonly error: CommandError } {
  return {
    ok: false,
    error: {
      code: 'not-supported',
      hint: `capability "${id}" is not registered`,
      retryable: false,
      recoveryActions: [],
    },
  };
}

export class CapabilityRegistrationError extends Error {
  readonly code: 'invalid-capability' | 'capability-id-conflict';

  constructor(code: CapabilityRegistrationError['code'], message: string) {
    super(message);
    this.name = 'CapabilityRegistrationError';
    this.code = code;
  }
}

export class CapabilityRegistry {
  private readonly registrations = new Map<string, CapabilityRegistration>();

  register(registration: CapabilityRegistration): void {
    if (!isCapabilityDescriptor(registration)) {
      throw new CapabilityRegistrationError(
        'invalid-capability',
        'capability registration must use a subject.verb id and schema fields',
      );
    }
    if (registration.id !== capabilityId(registration.subject, registration.verb)) {
      throw new CapabilityRegistrationError(
        'invalid-capability',
        `capability id "${registration.id}" must equal subject.verb`,
      );
    }
    if (this.registrations.has(registration.id)) {
      throw new CapabilityRegistrationError(
        'capability-id-conflict',
        `capability "${registration.id}" is already registered`,
      );
    }
    this.registrations.set(registration.id, Object.freeze({ ...registration }));
  }

  unregister(id: string): boolean {
    return this.registrations.delete(id);
  }

  discover(options: CapabilityDiscoveryOptions = {}): readonly CapabilityDescriptor[] {
    const includeUnavailable = options.includeUnavailable ?? true;
    return Array.from(this.registrations.values())
      .map((registration) => publicDescriptor(registration, options.host))
      .filter((descriptor) => includeUnavailable || descriptor.availability.available);
  }

  describe(id: string, options: CapabilityDiscoveryOptions = {}): CapabilityDescriptor | undefined {
    const registration = this.registrations.get(id);
    if (registration === undefined) return undefined;
    const descriptor = publicDescriptor(registration, options.host);
    return options.includeUnavailable === false && !descriptor.availability.available
      ? undefined
      : descriptor;
  }

  manifest(options: CapabilityDiscoveryOptions = {}): CapabilityManifest {
    return createCapabilityManifest(this.discover(options), '0.1.0');
  }

  async execute(
    id: string,
    input: unknown,
    options: { readonly host?: CapabilityHost; readonly signal?: AbortSignal } = {},
  ): Promise<{ readonly ok: true; readonly result: unknown } | { readonly ok: false; readonly error: CommandError }> {
    const registration = this.registrations.get(id);
    const descriptor = registration === undefined ? undefined : publicDescriptor(registration, options.host);
    if (registration === undefined || descriptor === undefined) return unknownCapabilityResult(id);
    if (!descriptor.availability.available || registration.executor === undefined) return unavailableResult(descriptor);
    return { ok: true, result: await registration.executor.execute(input, options) };
  }
}

export function compareHostCapabilities(
  registry: CapabilityRegistry,
  hosts: readonly CapabilityHost[] = DEFAULT_HOSTS,
): HostParityReport {
  const nonDisplayIdsByHost = {} as Record<CapabilityHost, readonly string[]>;
  const availabilityByHost: Partial<
    Record<CapabilityHost, Readonly<Record<string, CapabilityAvailability>>>
  > = {};
  for (const host of hosts) {
    const entries = registry.discover({ host });
    nonDisplayIdsByHost[host] = entries
      .filter((entry) => entry.presentationOnly !== true)
      .map((entry) => entry.id);
    availabilityByHost[host] = Object.freeze(
      Object.fromEntries(entries.map((entry) => [entry.id, entry.availability])),
    );
  }
  const reference = nonDisplayIdsByHost[hosts[0] ?? 'bun'] ?? [];
  const differences = hosts.slice(1).flatMap((host) => {
    const current = nonDisplayIdsByHost[host] ?? [];
    const same = current.length === reference.length && current.every((id, index) => id === reference[index]);
    return same ? [] : [`non-display capability set differs on ${host}`];
  });
  return {
    hosts: [...hosts],
    nonDisplayIdsByHost,
    nonDisplayDifferences: differences,
    availabilityByHost,
  };
}
