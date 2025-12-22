# DAO Contract (Entity-Agnostic)

DAOs are `@injectable()` classes using pg-promise via DBContainer.

## DAO responsibilities
- Execute SQL
- Return typed results
- Enforce soft-delete filters (when applicable)

## DAO forbidden behavior
- No imports from resources/ or controllers/
- No business rule orchestration
- No request/response handling
- No console logging (use a logger wrapper if needed)

## Soft delete convention
- Active rows: `deleted IS NULL`
- Trashed rows: `deleted IS NOT NULL`
- Trash mutation sets:
    - `deleted = NOW()`
    - optional `deleted_reason`
    - `modified = NOW()` if the table uses modified timestamps

## Return conventions
- getById: `Promise<T | null>`
- list/getMany: `Promise<{ items: T[]; count: number }>` (naming in code can be entity-specific)
- create/update/trash/state toggles: return updated row via `RETURNING *` (or explicit columns if standardized)
- bulk actions may return `number` (count)

## Update-by-id baseline pattern
Default pattern matches current code:
1) fetch existing row
2) merge allowed fields
3) update full column set
4) `RETURNING *`

Explicit rule:
- If updates must allow setting fields to NULL, do not use `??` merge. Use “field present” checks.

## Transactions / tasks
- Bulk operations may use `db.task(async t => ...)`
- If atomicity is required across multiple statements, use `db.tx(...)`

## Null-setting policy
Generic update-by-id methods do NOT support intentionally setting fields to NULL.
- Updates merge using existing values when a field is missing (often via `??`).
- Any operation that must set a field to NULL must be implemented as a dedicated DAO method
  (example: `undeleteById` sets `deleted = NULL`, `deleted_reason = NULL`, updates timestamps).