# Service Dependency Policy (Option C)

## Rule
- Entity services must be thin and must not depend on other services.
- Orchestrator services may depend on entity services and DAOs.

## Definitions
### Entity service
A service whose responsibility is one entity (CountyService, CampaignService, etc.)
- CRUD + meta updates
- Validation/normalization for that entity
- DAO calls
- No cross-entity orchestration

### Orchestrator service
A service whose responsibility is a workflow across entities (LeadService)
- May call multiple entity services
- May call multiple DAOs
- Owns workflow rules and decision logic (cooldowns, whitelists, blacklists, sending flows, etc.)

## Decision boundary
If a service requires more than one entity to complete its work, it is an orchestrator and may depend on other services.