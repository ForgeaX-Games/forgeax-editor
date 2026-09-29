/** Project the current Engine report through the shared carrier wire contract. */
import {
  VagCarrierHeartbeatSchema,
  type VagCarrierPayload,
} from '@forgeax/editor-core/protocol';

export type VagExecutionEnvelope = NonNullable<VagCarrierPayload['execution']>;

export function toVagExecutionEnvelope(report: unknown): VagExecutionEnvelope | null {
  const parsed = VagCarrierHeartbeatSchema.shape.payload.shape.execution.safeParse(report);
  return parsed.success ? parsed.data ?? null : null;
}
