// The screens that show decision queues beside their lists: run decisions, salary holds and stops, payroll inputs.

import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { HoldCriteriaSection, StopProposalForm } from './hold-proposals';
import { HoldList, StopList } from './holds';
import { InputBatchList, NewInputBatch } from './inputs';
import { HoldDecisionQueue, InputDecisionQueue, RunApprovalQueue, RunReviewQueue, StopDecisionQueue } from './queues';
import { HOLD_DECIDE, HOLD_READ, INPUT_APPROVE, INPUT_PREPARE, INPUT_READ, RUN_APPROVE, RUN_REVIEW, STOP_DECIDE, STOP_PROPOSE, STOP_READ } from './shared';

export function RunDecisionsScreen() {
  const { can } = useSession();
  if (!can(RUN_REVIEW) && !can(RUN_APPROVE)) {
    return (
      <Section title="Payroll run decisions">
        <Empty>The selected role does not review or approve payroll runs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      <RunReviewQueue />
      <RunApprovalQueue />
    </div>
  );
}

export function HoldsScreen() {
  const { can } = useSession();
  if (!can(HOLD_READ) && !can(STOP_READ) && !can(STOP_PROPOSE)) {
    return (
      <Section title="Salary holds and stops">
        <Empty refusal>The selected role cannot see salary holds or salary stops.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(HOLD_DECIDE) && <HoldDecisionQueue />}
      {can(HOLD_READ) && <HoldList />}
      {can(HOLD_READ) && <HoldCriteriaSection />}
      {can(STOP_DECIDE) && <StopDecisionQueue />}
      {can(STOP_PROPOSE) && <StopProposalForm />}
      {can(STOP_READ) && <StopList />}
    </div>
  );
}

export function InputsScreen() {
  const { can } = useSession();
  if (!can(INPUT_READ) && !can(INPUT_PREPARE) && !can(INPUT_APPROVE)) {
    return (
      <Section title="Payroll inputs">
        <Empty refusal>The selected role cannot see payroll inputs.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(INPUT_APPROVE) && <InputDecisionQueue />}
      {can(INPUT_PREPARE) && <NewInputBatch />}
      {can(INPUT_READ) && <InputBatchList />}
    </div>
  );
}
