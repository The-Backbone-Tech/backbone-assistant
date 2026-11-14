/** Check before sending credentials: parameterized statements can still be logged by PostgreSQL. */
export const LOG_POLICY_QUERY = `SELECT current_setting('log_parameter_max_length') AS parameters,
  current_setting('log_parameter_max_length_on_error') AS errors,
  current_setting('auto_explain.log_parameter_max_length', true) AS plans,
  current_setting('auto_explain.log_min_duration', true) AS plan_duration,
  current_setting('debug_print_plan') AS debug_plan,
  current_setting('pgaudit.log_parameter', true) AS audit`;

export function safeLogPolicy(row: Record<string, unknown> | undefined): boolean {
  if (!row || row.parameters !== '0' || row.errors !== '0') return false;
  const absent = (value: unknown) => value == null || value === '';
  return (absent(row.plans) || row.plans === '0') &&
    (absent(row.plan_duration) || row.plan_duration === '-1' || row.plan_duration === '-1ms') &&
    row.debug_plan === 'off' && (absent(row.audit) || row.audit === 'off');
}
