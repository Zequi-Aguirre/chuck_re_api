# Resource/Controller Contract

Resources are `@injectable()` classes that own an Express Router.

## Responsibilities
- Parse input (params/query/body)
- Call service methods
- Convert errors to HTTP responses
- Return consistent response shapes

## Forbidden behavior
- No SQL
- No cross-entity orchestration logic
- No importing DAOs directly (resources call services)

## Error mapping baseline
- 400: validation / bad input
- 401: missing or invalid auth
- 403: authenticated but forbidden
- 404: not found
- 409: conflict (already exists, invalid state transition)
- 500: unexpected

## Auth usage
- Auth middleware is applied at route mount-time in AutomatorServer (preferred)
- Per-route admin gating should be explicit (avoid substring path checks)