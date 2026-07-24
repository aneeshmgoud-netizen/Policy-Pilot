import { Injectable, Logger } from '@nestjs/common';
import { maskEmployeeId } from '../common/pii.util';
import { HumanDecisionTypeValue } from './dto/create-decision.dto';

export interface ExecutionCommand {
  decisionType: HumanDecisionTypeValue;
  employeeId: string;
  targetSystem: string;
  entitlementKey: string;
}

// Mocked downstream execution boundary. In production this would call the
// entitlement-provisioning system (HRIS/ITSM); here it only logs. Crucially,
// this is the ONLY place a decision could ever mutate entitlements, and it is
// reached solely from a recorded HUMAN decision — never from the AI path. That
// is the Human-in-the-Loop boundary made concrete. The employee id is masked in
// the log per the PII rule.
@Injectable()
export class ExecutionAdapter {
  private readonly logger = new Logger(ExecutionAdapter.name);

  execute(command: ExecutionCommand): void {
    const action = this.actionFor(command.decisionType);
    this.logger.log(
      `Executing ${action} for ${maskEmployeeId(command.employeeId)} on ` +
        `${command.targetSystem}/${command.entitlementKey} (decision=${command.decisionType})`,
    );
  }

  private actionFor(decisionType: HumanDecisionTypeValue): string {
    switch (decisionType) {
      case 'APPROVE':
        return 'GRANT';
      case 'OVERRIDE':
        return 'GRANT (override)';
      case 'DENY':
        return 'NO-OP (deny)';
    }
  }
}
