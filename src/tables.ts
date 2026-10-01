export const DB_SCHEMA = 'public';

/** Route slug (GET /v1/<slug>) → table name in DB_SCHEMA. */
export const TABLES = {
  'dealer-month-activity': 'fct_dealer_month_activity_table',
  'high-potential-taluka-month': 'fct_high_potential_taluka_month_table',
  'user-month-summary': 'fct_user_month_summary_table',
} as const;

export type TableSlug = keyof typeof TABLES;

export const TABLE_SLUGS = Object.keys(TABLES) as TableSlug[];
