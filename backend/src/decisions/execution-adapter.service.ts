import { Injectable, Logger } from '@nestjs/common';
import { maskEmployeeId } from '../common/pii.util';
import { DecisionOutcomeValue } from './dto/create-decision.dto';

export interface ExecutionCommand {
  // Stable per DecisionExecution row — passed on every attempt (including
  // BullMQ retries and sweeper-recovered replays) so a real downstream
  // system could dedupe on it. This mock adapter dedupes on it too, so a
  // replay after a crash demonstrably never re-effects.
  idempotencyKey: string;
  outcome: DecisionOutcomeValue;
  employeeId: string;
  targetSystem: string;
  entitlementKey: string;
}

// Mocked downstream execution boundary. In production this would call the
// entitlement-provisioning system (HRIS/ITSM); here it only logs. Crucially,
// this is the ONLY place a decision could ever mutate entitlements, and it is
// reached solely through DecisionExecutionProcessor, which itself only ever
// claims a row created from a persisted HumanDecision — never from the AI
// path. That is the Human-in-the-Loop boundary made concrete.
//
// The in-memory `seen` set stands in for a real downstream system's own
// idempotency-key dedup table. It only proves the *contract* — "the same key
// must not re-effect" — within this process's lifetime; it is not itself a
// durable idempotency store, so it does not survive a process restart. A
// real integration would rely on the downstream system's own persisted
// dedup, not on this adapter's memory.
@Injectable()
export class ExecutionAdapter {
  private readonly logger = new Logger(ExecutionAdapter.name);
  private readonly seen = new Set<string>();

  async execute(command: ExecutionCommand): Promise<void> {
    if (this.seen.has(command.idempotencyKey)) {
      this.logger.warn(
        `Suppressed duplicate execution for idempotency key ${command.idempotencyKey} ` +
          `— already effected once; this replay is a safe no-op.`,
      );
      return;
    }

    const action = command.outcome === 'GRANT' ? 'GRANT' : 'NO-OP (deny)';
    this.logger.log(
      `Executing ${action} for ${maskEmployeeId(command.employeeId)} on ` +
        `${command.targetSystem}/${command.entitlementKey} ` +
        `(outcome=${command.outcome}, idempotencyKey=${command.idempotencyKey})`,
    );

    this.seen.add(command.idempotencyKey);
  }
}
