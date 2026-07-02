import { injectable } from "tsyringe";
import { CreditLedgerRow, CreditLedgerStore } from "../metering/CreditLedgerStore";
import { CreditService } from "../metering/CreditService";
import { TextJakeCustomerService } from "../customers/TextJakeCustomerService";
import { TextJakeCustomerStore } from "../customers/TextJakeCustomerStore";
import { AdminTextCustomerView } from "./AdminTypes";

/** The new balance plus the ledger entry a grant produced. */
export interface TextCustomerGrantResult {
  customer: AdminTextCustomerView;
  entry: CreditLedgerRow;
  balance: number;
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
    private readonly ledger: CreditLedgerStore
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
    return rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      ghlContactId: row.ghl_contact_id,
      creditBalance: balanceByAccount.get(row.id) ?? 0,
      createdAt: row.created_at,
      lastSeenAt: row.modified_at,
    }));
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
        ghlContactId: customer.ghlContactId,
        creditBalance: entry.balance_after,
        createdAt: customer.createdAt,
        lastSeenAt: customer.modifiedAt,
      },
      entry,
      balance: entry.balance_after,
    };
  }
}
