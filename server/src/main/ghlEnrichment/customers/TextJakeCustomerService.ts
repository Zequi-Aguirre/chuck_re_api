import { injectable } from "tsyringe";
import { TextJakeCustomerRow, TextJakeCustomerStore } from "./TextJakeCustomerStore";
import { TextJakeCustomer } from "./TextJakeCustomerTypes";

/**
 * The text-Jake customer service (JAK-115) — resolves the tier-1 billing identity.
 *
 * Text-Jake bills the texting CUSTOMER, resolved by their SENDER phone number
 * (both text modes). This service owns "who is this texter and what account do
 * they pay from": it normalizes the phone, upserts the customer row, and exposes
 * a stable {@link TextJakeCustomer.creditAccountId} the JAK-109 ledger charges
 * against — so a given phone always maps to the same customer and balance, and
 * two different phones never share an account (billing isolation).
 */
@injectable()
export class TextJakeCustomerService {
  constructor(private readonly store: TextJakeCustomerStore) {}

  /**
   * Resolve (creating on first contact) the customer for a sender phone. Pass the
   * GHL contact id when known so status notes can target it; it's only set if we
   * don't already have one.
   */
  async resolveByPhone(
    phone: string,
    ghlContactId?: string | null
  ): Promise<TextJakeCustomer> {
    const normalized = normalizePhone(phone);
    const row = await this.store.upsertByPhone(normalized, ghlContactId ?? null);
    return toCustomer(row);
  }
}

/**
 * Normalize a phone to a stable key: trim and strip internal whitespace. GHL
 * sends E.164 already; this just guards against stray spaces so the same number
 * never splits into two customers.
 */
export function normalizePhone(phone: string): string {
  return String(phone).replace(/\s+/g, "").trim();
}

function toCustomer(row: TextJakeCustomerRow): TextJakeCustomer {
  return {
    id: row.id,
    phone: row.phone,
    ghlContactId: row.ghl_contact_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    // The credit account key IS the customer id — stable per customer.
    creditAccountId: row.id,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
  };
}
