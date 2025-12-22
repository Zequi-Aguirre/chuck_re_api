# Frontend Architecture Baseline (Vite + React + TSX)

## Structure
- client/src/components
    - admin: admin-only UI sections and subcomponents
    - common: shared domain UI (leads list/details, confirmation dialogs, etc.)
    - shared UI components (Pagination, LoadingOverlay, etc.)
- client/src/views
    - adminViews: admin pages
    - userViews: user pages
- client/src/services
    - per-entity service classes that call backend endpoints
- client/src/config
    - axiosProvider + config (baseUrl)
- client/src/context
    - DataContext for session/user/filters persisted to localStorage
    - routes/ for AdminRoutes and ProtectedRoutes
- client/src/middleware
    - VerifyUser / VerifyAdmin wrappers for route gating
- client/src/types
    - frontend types (mirrors backend shape; should not be defined in components)

## Routing
- index.tsx lazy-loads App.tsx and wraps AppProps (DataContext provider).
- App.tsx mounts NavBar globally, public login routes, then ProtectedRoutes and AdminRoutes.

## UI framework
- MUI ThemeProvider configured in App.tsx.