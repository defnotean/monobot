/**
 * Convert Supabase's fulfilled `{ error }` response into a rejected operation.
 * Supabase query builders normally resolve even when PostgreSQL rejected the
 * query, so try/catch alone is not a durability boundary.
 */
export function assertSupabaseSuccess(result, operation = "Supabase operation", options = {}) {
  const error = result?.error;
  if (!error || options.allowCodes?.includes(error.code)) return result;

  const message = error.message || error.details || error.code || "unknown database error";
  /** @type {Error & { code?: string, supabaseError?: any }} */
  const wrapped = new Error(`${operation} failed: ${message}`);
  wrapped.code = error.code;
  wrapped.supabaseError = error;
  throw wrapped;
}

/** Await a Supabase query and reject on either promise or response errors. */
export async function checkedSupabase(query, operation, options) {
  return assertSupabaseSuccess(await query, operation, options);
}
