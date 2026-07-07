import { injectable } from "tsyringe";
import { CreditLedgerRow, CreditLedgerStore } from "../metering/CreditLedgerStore";
import { CreditBalances, CreditService } from "../metering/CreditService";
import { CREDIT_TYPES, CreditType } from "../metering/CreditCosts";
import { normalizePhone, TextJakeCustomerService } from "../customers/TextJakeCustomerService";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "../customers/TextJakeCustomerStore";
import { TextCustomerStatus } from "../customers/TextJakeCustomerTypes";
import {
  FindContactResult,
  TextCustomerGhlSyncService,
  TextCustomerSyncResult,
} from "../customers/TextCustomerGhlSyncService";
import { AdminTextCustomerView } from "./AdminTypes";

/** The new balance plus the ledger entry a grant produced. */
export interface TextCustomerGrantResult {
  customer: AdminTextCustomerView;
  entry: CreditLedgerRow;
  balance: number;
}

/** The admin-editable identity + profile for a text customer (JAK-146). */
export interface TextCustomerInput {
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

/** A saved customer view plus the outcome of syncing them to GHL (JAK-147). */
export interface TextCustomerWriteResult {
  customer: AdminTextCustomerView;
  sync: TextCustomerSyncResult;
}

/**
 * The result of a two-level hold status change (JAK-148/JAK-remove-ghl-hold):
 * the updated customer view. Holding/deactivating is now SERVER-SIDE ONLY — the
 * status change never writes to GHL, so there is no sync outcome to return.
 */
export interface TextCustomerStatusResult {
  customer: AdminTextCustomerView;
}

/**
 * The admin dashboard's surface over tier-1 text-Jake customers (JAK-129).
 *
 * Closes a gap in the beta top-up path: the connection grant (JAK-113) credits
 * a GHL sub-account by locationId, but a gateway texter is keyed by SENDER phone
 * in `text_jake_customers` and bills against their OWN credit account — whose key
 * IS the customer id (JAK-115). Those are different account keys, so a texter who
 * ran "out of Jake credits" could never be topped up. This adapter reuses the
 * existing services to fix that:
 *   - {@link list} joins {@link TextJakeCustomerStore.listAll} against ONE
 *     balance scan ({@link CreditLedgerStore.listBalances}) — the customer id is
 *     the ledger account key — so no per-customer balance query (JAK-112 pattern).
 *   - {@link grantCredits} resolves-or-creates the customer by phone
 *     ({@link TextJakeCustomerService.resolveByPhone}) and grants via the SAME
 *     ledger path the connection grant uses ({@link CreditService.grantCredits}),
 *     passing the customer's credit-account id as the account key.
 *
 * It owns no business logic and no persistence beyond the join — the ledger,
 * costs, and customer resolution all live in the services it delegates to.
 */
@injectable()
export class AdminTextCustomerService {
  constructor(
    private readonly customers: TextJakeCustomerService,
    private readonly customerStore: TextJakeCustomerStore,
    private readonly credits: CreditService,
    private readonly ledger: CreditLedgerStore,
    private readonly sync: TextCustomerGhlSyncService
  ) {}

  /**
   * Every text-Jake customer with their current credit balance. One customer
   * scan + one balance scan, folded in memory — the customer id is the ledger
   * account key, so a customer with no ledger activity yet reads as balance 0.
   */
  async list(): Promise<AdminTextCustomerView[]> {
    // One customer scan + one balance scan PER bucket (JAK-161: report / skiptrace
    // / comps), all in parallel, folded in memory — still no per-customer query.
    const [rows, ...perType] = await Promise.all([
      this.customerStore.listAll(),
      ...CREDIT_TYPES.map((type) => this.ledger.listBalances(type)),
    ]);
    // account id → { report, skiptrace, comps }, defaulting each unseen bucket to 0.
    const byAccount = new Map<string, CreditBalances>();
    CREDIT_TYPES.forEach((type, i) => {
      for (const b of perType[i]) {
        const bucket = byAccount.get(b.location_id) ?? zeroBalances();
        bucket[type] = b.balance;
        byAccount.set(b.location_id, bucket);
      }
    });
    return rows.map((row) => toView(row, byAccount.get(row.id) ?? zeroBalances()));
  }

  /**
   * Create a text customer from the admin dashboard (JAK-146) with an optional
   * name + email. The phone is normalized to the same stable key the billing
   * path uses, so a later text from that number maps to this same customer. A
   * brand-new customer has a 0 balance (no ledger activity yet).
   *
   * JAK-147: after persisting, the customer is synced to the Jake GHL sub-account
   * (find-or-create the contact + set "text Jake" approved). A sync problem never
   * fails the create — the DB row is the billing identity; the sync outcome is
   * returned alongside for the admin to see.
   */
  async create(input: TextCustomerInput): Promise<TextCustomerWriteResult> {
    const phone = normalizePhone(input.phone);
    const row = await this.customerStore.create(phone, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
    });
    // Seed the three per-feature credit balances from the admin-editable defaults
    // (JAK-161: report / skiptrace / comps). Idempotent, so it mirrors the passive
    // first-contact seeding without ever double-granting.
    await this.credits.seedNewCustomer(row.id);
    const sync = await this.sync.syncCustomer({ phone, ...profileOf(input) });
    const finalRow = await this.persistContactId(row, sync);
    const credits = await this.credits.getBalances(finalRow.id);
    return { customer: toView(finalRow, credits), sync };
  }

  /**
   * Update a text customer's phone + profile from the admin dashboard (JAK-146).
   * Returns the updated view + GHL sync outcome (JAK-147), or null if no live
   * customer has that id. Credits are untouched here — that's the grant path.
   */
  async update(id: string, input: TextCustomerInput): Promise<TextCustomerWriteResult | null> {
    const phone = normalizePhone(input.phone);
    const row = await this.customerStore.updateProfile(id, phone, {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
    });
    if (!row) return null;
    const sync = await this.sync.syncCustomer({ phone, ...profileOf(input) });
    const finalRow = await this.persistContactId(row, sync);
    const credits = await this.credits.getBalances(finalRow.id);
    return { customer: toView(finalRow, credits), sync };
  }

  /**
   * Look up the existing Jake-sub-account contact for a phone (JAK-147) so the
   * admin form can prefill name/email before saving. Delegates to the sync
   * service, which never throws.
   */
  async findContact(phone: string): Promise<FindContactResult> {
    return this.sync.findContact(normalizePhone(phone));
  }

  /**
   * Persist the GHL contact id a live sync resolved, so re-saves and the billing
   * path share the same link. A skipped/failed sync (no id) leaves the row as-is.
   */
  private async persistContactId(
    row: TextJakeCustomerRow,
    sync: TextCustomerSyncResult
  ): Promise<TextJakeCustomerRow> {
    if (sync.ghlContactId && sync.ghlContactId !== row.ghl_contact_id) {
      const updated = await this.customerStore.setGhlContactId(row.id, sync.ghlContactId);
      if (updated) return updated;
    }
    return row;
  }

  /**
   * Grant (or, via a negative amount + `adjustment`, correct) a text customer's
   * credit balance in ONE feature bucket (JAK-161/JAK-162) — report, skiptrace,
   * or comps — by their sender phone, the tier-1 beta top-up path. The customer
   * is resolved-or-created first, so an admin can credit a number that hasn't
   * texted in yet. Credits are granted against the customer's OWN credit-account
   * id, never a connection locationId. `type` defaults to report so pre-split
   * callers are unchanged. Returns the granted bucket's new balance plus the
   * customer view carrying all three balances.
   */
  async grantCredits(
    phone: string,
    amount: number,
    reason?: string,
    type: CreditType = "report"
  ): Promise<TextCustomerGrantResult> {
    const customer = await this.customers.resolveByPhone(phone);
    const entry = await this.credits.grant(
      customer.creditAccountId,
      type,
      amount,
      reason === "adjustment" ? "adjustment" : "manual_grant"
    );
    // Read back all three so the card refreshes every bucket, not just the one edited.
    const credits = await this.credits.getBalances(customer.creditAccountId);
    return {
      customer: {
        id: customer.id,
        phone: customer.phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        ghlContactId: customer.ghlContactId,
        status: customer.status,
        creditBalance: credits.report,
        credits,
        createdAt: customer.createdAt,
        lastSeenAt: customer.modifiedAt,
      },
      entry,
      balance: entry.balance_after,
    };
  }

  /**
   * Change a text customer's two-level hold status — now SERVER-SIDE ONLY
   * (JAK-remove-ghl-hold). Zequi removed the GHL automation filter that read the
   * "text Jake" approval field, so hold/deactivate no longer touches GHL at all;
   * this method only persists the status. Jake enforces the hold itself on the
   * inbound path ({@link JakeAssistantService.handleInboundMessage}):
   *  - `on_hold`     — Jake replies a hold notice, no work / no charge.
   *  - `deactivated` — Jake refuses to process the inbound, no charge.
   *  - `active`      — normal processing resumes.
   * Credits are NEVER read or written here — a hold can't move a balance. Returns
   * the updated view, or null if no live customer has that id.
   */
  async changeStatus(
    id: string,
    status: TextCustomerStatus
  ): Promise<TextCustomerStatusResult | null> {
    const row = await this.customerStore.setStatus(id, status);
    if (!row) return null;

    // Read-only balance fetch for the view — the ledger is never mutated here.
    const credits = await this.credits.getBalances(row.id);
    return { customer: toView(row, credits) };
  }
}

/** A fresh all-zero per-bucket balance set — the default for a customer with no ledger yet. */
function zeroBalances(): CreditBalances {
  return { report: 0, skiptrace: 0, comps: 0 };
}

/** The name/email slice of an input, for the GHL sync payload (phone added by caller). */
function profileOf(input: TextCustomerInput): {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} {
  return { firstName: input.firstName, lastName: input.lastName, email: input.email };
}

/** Fold a raw customer row + its three resolved balances into the safe admin view. */
function toView(row: TextJakeCustomerRow, credits: CreditBalances): AdminTextCustomerView {
  return {
    id: row.id,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    ghlContactId: row.ghl_contact_id,
    // Two-level hold state (JAK-148); a pre-ticket row with no column reads active.
    status: row.status ?? "active",
    // Legacy single balance mirrors the report bucket (JAK-161).
    creditBalance: credits.report,
    credits,
    createdAt: row.created_at,
    lastSeenAt: row.modified_at,
  };
}
