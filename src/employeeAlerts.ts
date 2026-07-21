// Pure alert logic for the Employees dashboard: contract expiry, probation
// ending, and missing contracts. Kept free of DB/Express so it can be unit
// tested with a fixed "today".

export const CONTRACT_EXPIRY_WINDOW_DAYS = 60;
export const PROBATION_ENDING_WINDOW_DAYS = 14;

export interface EmployeeAlertInput {
  id: string;
  name: string;
  contract_end: string | Date | null;
  probation_end: string | Date | null;
  has_contract: boolean;
}

export interface EmployeeAlert {
  employee_id: string;
  employee_name: string;
  type: 'contract_expired' | 'contract_expiring' | 'probation_ending' | 'no_contract';
  /** Days from today to the relevant date (negative = already past). */
  days: number | null;
  message: string;
}

/** Whole days from `today` to `date` (negative when `date` is in the past). */
export function daysUntil(date: string | Date, today: Date): number {
  const d = typeof date === 'string' ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : date;
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return Math.round((d.getTime() - t.getTime()) / 86_400_000);
}

export function computeEmployeeAlerts(employees: EmployeeAlertInput[], today: Date): EmployeeAlert[] {
  const alerts: EmployeeAlert[] = [];

  for (const e of employees) {
    if (e.contract_end != null) {
      const days = daysUntil(e.contract_end as string | Date, today);
      if (days < 0) {
        alerts.push({
          employee_id: e.id, employee_name: e.name, type: 'contract_expired', days,
          message: `${e.name}'s contract expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`,
        });
      } else if (days <= CONTRACT_EXPIRY_WINDOW_DAYS) {
        alerts.push({
          employee_id: e.id, employee_name: e.name, type: 'contract_expiring', days,
          message: `${e.name}'s contract expires in ${days} day${days === 1 ? '' : 's'}`,
        });
      }
    }

    if (e.probation_end != null) {
      const days = daysUntil(e.probation_end as string | Date, today);
      if (days >= 0 && days <= PROBATION_ENDING_WINDOW_DAYS) {
        alerts.push({
          employee_id: e.id, employee_name: e.name, type: 'probation_ending', days,
          message: `${e.name}'s probation ends in ${days} day${days === 1 ? '' : 's'}`,
        });
      }
    }

    if (!e.has_contract) {
      alerts.push({
        employee_id: e.id, employee_name: e.name, type: 'no_contract', days: null,
        message: `${e.name} has no contract uploaded`,
      });
    }
  }

  // Most urgent first: expired, then soonest dates, then missing contracts.
  const rank = { contract_expired: 0, contract_expiring: 1, probation_ending: 1, no_contract: 2 };
  return alerts.sort((a, b) => rank[a.type] - rank[b.type] || (a.days ?? 0) - (b.days ?? 0));
}
