import { injectable } from "tsyringe";
import { CreditLedgerRow, CreditLedgerStore } from "../metering/CreditLedgerStore";
import { CreditService } from "../metering/CreditService";
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
 * The result of a two-level hold status change (JAK-148): the updated customer
 * view plus the GHL "text Jake" field-flip outcome. `sync` is null for the soft
 * on_hold path, which leaves the approval field untouched.
 */
export interface TextCustomerStatusResult {
  customer: AdminTextCustomerView;
  sync: TextCustomerSyncResult | null;
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
    const [rows, balances] = await Promise.all([
      this.customerStore.listAll(),
      this.ledger.listBalances(),
    ]);
    const balanceByAccount = new Map(balances.map((b) => [b.location_id, b.balance]));
    return rows.map((row) => toView(row, balanceByAccount.get(row.id) ?? 0));
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
    const sync = await this.sync.syncCustomer({ phone, ...profileOf(input) });
    const finalRow = await this.persistContactId(row, sync);
    return { customer: toView(finalRow, 0), sync };
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
    const balance = await this.credits.getBalance(finalRow.id);
    return { customer: toView(finalRow, balance), sync };
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
   * credit balance by their sender phone — the tier-1 beta top-up path. The
   * customer is resolved-or-created first, so an admin can credit a number that
   * hasn't texted in yet. Credits are granted against the customer's OWN
   * credit-account id, never a connection locationId. Returns the new balance.
   */
  async grantCredits(
    phone: string,
    amount: number,
    reason?: string
  ): Promise<TextCustomerGrantResult> {
    const customer = await this.customers.resolveByPhone(phone);
    const entry = await this.credits.grantCredits(
      customer.creditAccountId,
      amount,
      reason === "adjustment" ? "adjustment" : "manual_grant"
    );
    return {
      customer: {
        id: customer.id,
        phone: customer.phone,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        ghlContactId: customer.ghlContactId,
        status: customer.status,
        creditBalance: entry.balance_after,
        createdAt: customer.createdAt,
        lastSeenAt: customer.modifiedAt,
      },
      entry,
      balance: entry.balance_after,
    };
  }

  /**
   * Change a text customer's two-level hold status (JAK-148) and, for the hard
   * states, flip the GHL "text Jake" approval field through the JAK-147 sync:
   *  - `on_hold`     — SOFT: persist the status ONLY. The approval field STAYS
   *    set, so GHL keeps forwarding their texts; Jake intercepts inbound and
   *    replies a hold notice server-side (no GHL write here, no sync outcome).
   *  - `deactivated` — HARD: persist, then set "text Jake" UNAPPROVED so GHL
   *    stops forwarding entirely.
   *  - `active`      — reactivate: persist, then re-approve "text Jake" so GHL
   *    forwards again (covers coming back from either hold state; idempotent).
   * Credits are NEVER read or written here — a hold can't move a balance. Returns
   * the updated view + the GHL sync outcome (null for the soft on_hold path), or
   * null if no live customer has that id.
   */
  async changeStatus(
    id: string,
    status: TextCustomerStatus
  ): Promise<TextCustomerStatusResult | null> {
    const row = await this.customerStore.setStatus(id, status);
    if (!row) return null;

    // Only the hard states touch GHL: deactivate unapproves, reactivate re-approves.
    // The soft on_hold intentionally leaves the approval field alone.
    let sync: TextCustomerSyncResult | null = null;
    if (status === "deactivated" || status === "active") {
      sync = await this.sync.setApproval(
        { phone: row.phone, firstName: row.first_name, lastName: row.last_name, email: row.email },
        status === "active"
      );
    }

    const finalRow = sync ? await this.persistContactId(row, sync) : row;
    // Read-only balance fetch for the view — the ledger is never mutated here.
    const balance = await this.credits.getBalance(finalRow.id);
    return { customer: toView(finalRow, balance), sync };
  }
}

/** The name/email slice of an input, for the GHL sync payload (phone added by caller). */
function profileOf(input: TextCustomerInput): {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
} {
  return { firstName: input.firstName, lastName: input.lastName, email: input.email };
}

/** Fold a raw customer row + its resolved balance into the safe admin view. */
function toView(row: TextJakeCustomerRow, creditBalance: number): AdminTextCustomerView {
  return {
    id: row.id,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    ghlContactId: row.ghl_contact_id,
    // Two-level hold state (JAK-148); a pre-ticket row with no column reads active.
    status: row.status ?? "active",
    creditBalance,
    createdAt: row.created_at,
    lastSeenAt: row.modified_at,
  };
}
