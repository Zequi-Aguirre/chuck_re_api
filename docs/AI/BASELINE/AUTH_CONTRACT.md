# Auth Contract (JWT + req.user)

## Mechanism
- Authenticator verifies Bearer token via JWT secret
- Loads user from DB and sets `req.user`
- If token expires within 4 hours, sets `New-Token` header with refreshed token

## Request typing
- Express Request is augmented to include `user`

## Status codes
- 401 for missing/invalid token
- 403 for forbidden role
- Token expired should not use 405 (405 is Method Not Allowed). Use 401.

## Admin routing policy (baseline)
Avoid `req.path.includes("admin")`.
Preferred:
- Mount admin routes under `/api/admin/...` and apply admin middleware explicitly