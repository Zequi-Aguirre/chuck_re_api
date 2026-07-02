import { DependencyContainer } from "tsyringe";
import { GhlEnrichmentConfig } from "../config/GhlEnrichmentConfig";
import { GhlApiDao } from "../../data/GhlApiDao";
import { PostgresDatabase } from "../../data/PostgresDatabase";
import { CredentialCipher } from "../connections/CredentialCipher";
import { GhlConnectionStore } from "../connections/GhlConnectionStore";
import { GhlConnectionService } from "../connections/GhlConnectionService";
import { GhlApiClient } from "../api/GhlApiClient";

/**
 * DI registration for the GHL enrichment module.
 *
 * tsyringe auto-resolves @injectable classes, so this is the module's single
 * explicit wiring point: it makes shared singletons obvious and gives later
 * tickets one function to hang new registrations on (OAuth service, webhook
 * verifier, field mapping…).
 *
 * It EXTENDS the existing MVP scaffolding (GhlApiDao, the parked Redis
 * enrichment worker, /api/ghl) — it does not duplicate it.
 *
 * Registrations are lazy singletons: nothing here connects to Postgres or reads
 * the encryption key at boot — the connection store initializes its pool on the
 * first query — so the server still boots on environments without a DB.
 */
export const registerGhlEnrichment = (c: DependencyContainer): void => {
  if (!c.isRegistered(GhlEnrichmentConfig)) {
    c.registerSingleton(GhlEnrichmentConfig);
  }

  // GhlApiDao already ships from the MVP; keep a single shared instance so the
  // enrichment module and the existing SMS/webhook paths reuse one client.
  if (!c.isRegistered(GhlApiDao)) {
    c.registerSingleton(GhlApiDao);
  }

  // JAK-102 — encrypted per-location connection/credential store. The single
  // source of GHL credentials for both the enrichment webhook path and
  // text-Jake (JAK-114). One shared pool + cipher + store + service.
  if (!c.isRegistered(PostgresDatabase)) {
    c.registerSingleton(PostgresDatabase);
  }
  if (!c.isRegistered(CredentialCipher)) {
    c.registerSingleton(CredentialCipher);
  }
  if (!c.isRegistered(GhlConnectionStore)) {
    c.registerSingleton(GhlConnectionStore);
  }
  if (!c.isRegistered(GhlConnectionService)) {
    c.registerSingleton(GhlConnectionService);
  }

  // JAK-104 — multi-tenant GHL API v2 client. Pulls per-location credentials
  // from the JAK-102 connection store (decrypted key + base_url), NOT from a
  // single Doppler key. Handles retries + rate-limit backoff. Supersedes the
  // single-tenant MVP GhlApiDao for the per-location path.
  if (!c.isRegistered(GhlApiClient)) {
    c.registerSingleton(GhlApiClient);
  }
};
