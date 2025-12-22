# Backend Architecture Baseline

This is the reusable baseline for my Node + TypeScript backends.

## Stack assumptions
- Express
- tsyringe DI (`@injectable()` classes)
- pg-promise DB access via DBContainer
- Shared types in `/types`

## Layers
### config/
- EnvConfig and other environment wiring
- DBContainer (pg-promise init + database() accessor)

### data/ (DAO)
- SQL execution + row returns only
- Soft delete filtering rules live here
- No HTTP, no Express imports
- No imports from resources/ or controllers/
- Allowed imports: config/, types/, dao-local helpers

### services/
Two kinds of services:

#### Entity services (thin)
- Single-entity operations (get/create/update/meta updates)
- May call only DAOs (default)
- Must not depend on other services

#### Orchestrator services (allowed to coordinate)
- Cross-entity workflows (example: LeadService coordinating affiliate/campaign/county/investor)
- May depend on entity services + DAOs
- Owns orchestration rules, cooldown logic, whitelists/blacklists coordination, etc.

### resources/
- Resource classes own Express Router
- Parse inputs, call services, translate errors to HTTP responses
- No SQL in resources
- Auth middleware can be applied at mount-time

### middleware/
- Express middleware + helpers
- Authenticator lives here
- CSV parsing/validation helpers live here (but types must live in /types)

### worker/
- Background worker (run as part of server if enabled by settings)
- Worker may call services/DAOs, but should reuse service logic where possible

### types/
- Single source of truth for domain types and DTOs
- Controllers/resources do not export “core” types