// The settlement settings screen (/lifecycle/settlement-settings): the settlement policy and the statutory rule packs, each shown only
// to a role that may read it, and its export for the navigation step (screens-registry.ts).
import { Link } from 'react-router-dom';
import { Hint } from '@/components/hint';
import type { ScreenRoute } from '../../screens';
import { useSession } from '../../session';
import { NotPermitted, Section, WarningNote } from '../../ui';
import { PackSection } from './packs';
import { PolicySection } from './policy';
import { LINK_ROW, PACK_READ, PATH, POLICY_READ, SETTLEMENT_READ, SETTLEMENTS_PATH } from './shared';

function SettlementSettingsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Settlement policy and statutory packs</h1>
      <Hint>
        A full-and-final settlement is calculated on the server under the settlement policy revision and the statutory rule packs in force on the employee’s last
        working date. Both are dated: a change is a new revision, and a revision takes effect only once a second person has activated it.
      </Hint>
      <WarningNote badge="two people">
        A statutory value is used only once one authorised person has validated it and another has activated it; until then the settlement of an employee it applies
        to stops, with “Rule pack not configured”.
      </WarningNote>
      {can(SETTLEMENT_READ) && (
        <p className={LINK_ROW}>
          <Link to={SETTLEMENTS_PATH}>Full and final settlements</Link>
        </p>
      )}
      {can(POLICY_READ) ? (
        <PolicySection />
      ) : (
        <Section title="Settlement policy">
          <NotPermitted>The selected role cannot view the settlement policy: that needs the payroll configuration read duty.</NotPermitted>
        </Section>
      )}
      {can(PACK_READ) ? (
        <PackSection />
      ) : (
        <Section title="Statutory rule packs">
          <NotPermitted>The selected role cannot view the statutory rule packs: that needs the statutory pack read duty.</NotPermitted>
        </Section>
      )}
    </>
  );
}

/**
 * The settings screen. The menu entry follows the payroll configuration read duty (the policy's writers and activators hold it);
 * an HR Administrator who reads the statutory packs reaches the screen from a settlement's calculation.
 */
export const SETTLEMENT_SETTINGS_SCREENS: ScreenRoute[] = [{ path: PATH, title: 'Settlement policy and statutory packs', permission: POLICY_READ, nav: true, component: SettlementSettingsScreen }];
