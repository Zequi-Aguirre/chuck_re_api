# Frontend Auth + Session Baseline

## Storage
- Token: localStorage key "token"
- App session/user/role/filters: localStorage key "appData" via DataContext

## Context
DataContext stores:
- session, loggedInUser, role
- leadFilters, countyFilters
- persisted with a version number (CURRENT_VERSION)

## Route gating
- VerifyUser: requires session; redirects to /login if missing
- VerifyAdmin: requires session and role in ("admin" | "superadmin")
    - if role fails: clears session/user/role and redirects

## Note
Backend also enforces admin routes; frontend gating is UX, not security.