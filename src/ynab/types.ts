// Subset of the YNAB API v1 schema (https://api.ynab.com/papi/open_api_spec.yaml)
// covering the fields this server reads. All amounts are in milliunits.

export interface CurrencyFormat {
  iso_code: string;
  decimal_digits: number;
  currency_symbol: string;
}

export interface PlanSummary {
  id: string;
  name: string;
  last_modified_on?: string | null;
  first_month?: string | null;
  last_month?: string | null;
  currency_format?: CurrencyFormat | null;
}

export interface Account {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  closed: boolean;
  note?: string | null;
  balance: number;
  cleared_balance: number;
  uncleared_balance: number;
  transfer_payee_id?: string | null;
  last_reconciled_at?: string | null;
  deleted: boolean;
}

export interface Category {
  id: string;
  category_group_id: string;
  category_group_name?: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  note?: string | null;
  budgeted: number;
  activity: number;
  balance: number;
  goal_type?: string | null;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_target_month?: string | null;
  goal_percentage_complete?: number | null;
  goal_under_funded?: number | null;
  goal_overall_left?: number | null;
  deleted: boolean;
}

export interface CategoryGroup {
  id: string;
  name: string;
  hidden: boolean;
  internal?: boolean;
  deleted: boolean;
  categories: Category[];
}

export interface Payee {
  id: string;
  name: string;
  transfer_account_id?: string | null;
  deleted: boolean;
}

export interface SubTransaction {
  id: string;
  amount: number;
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  deleted: boolean;
}

export interface Transaction {
  id: string;
  date: string;
  amount: number;
  memo?: string | null;
  cleared: string;
  approved: boolean;
  flag_color?: string | null;
  flag_name?: string | null;
  account_id: string;
  account_name?: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  import_id?: string | null;
  deleted: boolean;
  subtransactions?: SubTransaction[];
  /** Present on hybrid (category/payee/month) transaction lists. */
  type?: "transaction" | "subtransaction";
  parent_transaction_id?: string | null;
}

export interface ScheduledTransaction {
  id: string;
  date_first: string;
  date_next: string;
  frequency: string;
  amount: number;
  memo?: string | null;
  flag_color?: string | null;
  account_id: string;
  account_name?: string;
  payee_id?: string | null;
  payee_name?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  transfer_account_id?: string | null;
  deleted: boolean;
}

export interface MonthSummary {
  month: string;
  note?: string | null;
  income: number;
  budgeted: number;
  activity: number;
  to_be_budgeted: number;
  age_of_money?: number | null;
  deleted: boolean;
}

export interface MonthDetail extends MonthSummary {
  categories: Category[];
}

export interface MoneyMovement {
  id: string;
  month?: string | null;
  moved_at?: string | null;
  note?: string | null;
  from_category_id?: string | null;
  to_category_id?: string | null;
  amount: number;
}
