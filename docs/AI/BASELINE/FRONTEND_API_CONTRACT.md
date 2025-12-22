# Frontend API Contract

## AxiosProvider responsibilities
- baseURL from client/src/config/config.ts
- attach Bearer token from localStorage("token") on each request
- read refreshed token from response header "New-Token" and replace localStorage token
- handle auth failures consistently

## Auth failure policy
- 401: unauthenticated (expired/invalid token)
    - clear token
    - redirect to /login?sessionExpired=true
- 403: forbidden (insufficient role)
    - do not clear token by default
    - optionally redirect to "/" or show forbidden UI

## API service conventions
- Each service is a class receiving AxiosProvider.
- Methods return response.data typed.
- Endpoints should match backend resource routes exactly.

## Important
- Do not create a new axios instance per call unless intentionally required.
  Prefer a singleton axios instance with stable interceptors.