import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeEmployeeAlerts, daysUntil, type EmployeeAlertInput } from './employeeAlerts.js';

// Fixed clock so windows are deterministic.
const TODAY = new Date('2026-07-15T10:30:00Z');

function emp(overrides: Partial<EmployeeAlertInput>): EmployeeAlertInput {
  return {
    id: 'e1',
    name: 'Sara',
    contract_end: null,
    probation_end: null,
    has_contract: true,
    ...overrides,
  };
}

test('daysUntil counts whole days regardless of time of day', () => {
  assert.equal(daysUntil('2026-07-15', TODAY), 0);
  assert.equal(daysUntil('2026-07-16', TODAY), 1);
  assert.equal(daysUntil('2026-07-14', TODAY), -1);
  assert.equal(daysUntil('2026-09-13', TODAY), 60);
});

test('contract exactly 60 days out triggers contract_expiring', () => {
  const alerts = computeEmployeeAlerts([emp({ contract_end: '2026-09-13' })], TODAY);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'contract_expiring');
  assert.equal(alerts[0].days, 60);
});

test('contract 61 days out does not trigger', () => {
  const alerts = computeEmployeeAlerts([emp({ contract_end: '2026-09-14' })], TODAY);
  assert.equal(alerts.length, 0);
});

test('contract ending today triggers with days=0', () => {
  const alerts = computeEmployeeAlerts([emp({ contract_end: '2026-07-15' })], TODAY);
  assert.equal(alerts[0].type, 'contract_expiring');
  assert.equal(alerts[0].days, 0);
});

test('already-expired contract reports contract_expired with negative days', () => {
  const alerts = computeEmployeeAlerts([emp({ contract_end: '2026-07-01' })], TODAY);
  assert.equal(alerts[0].type, 'contract_expired');
  assert.equal(alerts[0].days, -14);
});

test('null contract_end produces no expiry alert', () => {
  const alerts = computeEmployeeAlerts([emp({ contract_end: null })], TODAY);
  assert.equal(alerts.length, 0);
});

test('probation ending within 14 days triggers; 15 days does not', () => {
  const within = computeEmployeeAlerts([emp({ probation_end: '2026-07-29' })], TODAY);
  assert.equal(within.length, 1);
  assert.equal(within[0].type, 'probation_ending');
  assert.equal(within[0].days, 14);

  const outside = computeEmployeeAlerts([emp({ probation_end: '2026-07-30' })], TODAY);
  assert.equal(outside.length, 0);
});

test('past probation end does not alert', () => {
  const alerts = computeEmployeeAlerts([emp({ probation_end: '2026-07-10' })], TODAY);
  assert.equal(alerts.length, 0);
});

test('missing contract triggers no_contract', () => {
  const alerts = computeEmployeeAlerts([emp({ has_contract: false })], TODAY);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'no_contract');
  assert.equal(alerts[0].days, null);
});

test('one employee can raise multiple alerts, sorted most urgent first', () => {
  const alerts = computeEmployeeAlerts(
    [
      emp({ id: 'a', name: 'A', contract_end: '2026-08-01', has_contract: false }), // expiring in 17d + no contract
      emp({ id: 'b', name: 'B', contract_end: '2026-07-01' }), // expired
    ],
    TODAY,
  );
  assert.deepEqual(
    alerts.map((a) => a.type),
    ['contract_expired', 'contract_expiring', 'no_contract'],
  );
});

test('empty list yields no alerts', () => {
  assert.deepEqual(computeEmployeeAlerts([], TODAY), []);
});

test('accepts Date objects for date fields (pg DATE columns)', () => {
  const alerts = computeEmployeeAlerts(
    [emp({ contract_end: new Date('2026-08-01T00:00:00Z') })],
    TODAY,
  );
  assert.equal(alerts[0].type, 'contract_expiring');
  assert.equal(alerts[0].days, 17);
});
