/** Condition names for the SQLSTATE codes Crashpad most often reports. */
const PG_ERROR_NAMES: Record<string, string> = {
  "42703": "undefined_column",
  "42P01": "undefined_table",
  "42883": "undefined_function",
  "42601": "syntax_error",
  "42804": "datatype_mismatch",
  "23502": "not_null_violation",
  "23503": "foreign_key_violation",
  "23505": "unique_violation",
  "23514": "check_violation",
  "22P02": "invalid_text_representation",
  "22003": "numeric_value_out_of_range",
  "57014": "query_canceled",
  "25006": "read_only_sql_transaction",
  "08P01": "protocol_violation",
};

export function pgErrorName(code: string | null): string {
  return code ? (PG_ERROR_NAMES[code] ?? code) : "error";
}

