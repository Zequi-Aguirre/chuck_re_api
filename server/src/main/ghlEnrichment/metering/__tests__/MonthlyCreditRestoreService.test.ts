import { mock, MockProxy } from "jest-mock-extended";
import { TextJakeCustomerStore, TextJakeCustomerRow } from "../../customers/TextJakeCustomerStore";
import { CreditService } from "../CreditService";
import { MonthlyCreditRestoreService } from "../MonthlyCreditRestoreService";

/**
 * JAK-monthly-credit-restore — the sweep's control flow, with a mocked store +
 * credit service and a driveable clock (no DB, no time). The SQL-level guarantees
 * (atomic claim, exact 1-month advance, backfill, real no-double-restore) are
 * pinned in MonthlyCreditRestore.integration.test.ts against a real Postgres.
 */

/** A test subclass with a fixed clock so `restoreDue()`'s default `asOf` is deterministic. */
class TestRestore extends MonthlyCreditRestoreService {
  public nowValue = new Date("2026-08-01T00:00:00Z");
  protected clock(): Date {
    return this.nowValue;
  }
}

const customer = (id: string): TextJakeCustomerRow =>
  ({
    id,
    phone: "+1555000" + id,
    ghl_contact_id: null,
    first_name: null,
    last_name: null,
    email: null,
    status: "active",
    report_count: 0,
    onboarding_asked_at: null,
    next_reset_at: new Date("2026-09-01T00:00:00Z"),
    created_at: new Date("2026-07-01T00:00:00Z"),
    modified_at: new Date("2026-07-01T00:00:00Z"),
    deleted_at: null,
  } as TextJakeCustomerRow);

describe("MonthlyCreditRestoreService", () => {
  let customers: MockProxy<TextJakeCustomerStore>;
  let credits: MockProxy<CreditService>;
  let service: TestRestore;

  beforeEach(() => {
    customers = mock<TextJakeCustomerStore>();
    credits = mock<CreditService>();
    credits.resetToDefaults.mockResolvedValue({ report: 50, skiptrace: 10, comps: 10 });
    service = new TestRestore(customers, credits);
  });

  it("restores every due customer to the effective default, once each", async () => {
    // The store yields two due customers, then signals "none left" with null.
    customers.claimDueForReset
      .mockResolvedValueOnce(customer("1"))
      .mockResolvedValueOnce(customer("2"))
      .mockResolvedValue(null);

    const summary = await service.restoreDue();

    expect(summary).toEqual({ restored: 2, accountIds: ["1", "2"] });
    // resetToDefaults is the SAME effective-default path the reset button uses —
    // called once per claimed customer, keyed by the customer id (= account id).
    expect(credits.resetToDefaults).toHaveBeenCalledTimes(2);
    expect(credits.resetToDefaults).toHaveBeenNthCalledWith(1, "1");
    expect(credits.resetToDefaults).toHaveBeenNthCalledWith(2, "2");
  });

  it("is a no-op when nobody is due (never touches credits)", async () => {
    customers.claimDueForReset.mockResolvedValue(null);

    const summary = await service.restoreDue();

    expect(summary).toEqual({ restored: 0, accountIds: [] });
    expect(credits.resetToDefaults).not.toHaveBeenCalled();
  });

  it("passes the default clock as `asOf` to the atomic claim", async () => {
    customers.claimDueForReset.mockResolvedValue(null);

    await service.restoreDue();

    expect(customers.claimDueForReset).toHaveBeenCalledWith(service.nowValue);
  });

  it("stops as soon as the claim drains — a second sweep finds nothing to re-restore", async () => {
    // First sweep claims one, then the guard advanced that customer's clock, so
    // the next claim (same asOf) returns null — modeling the atomic guard.
    customers.claimDueForReset.mockResolvedValueOnce(customer("1")).mockResolvedValue(null);
    const first = await service.restoreDue();
    const second = await service.restoreDue();

    expect(first.restored).toBe(1);
    expect(second.restored).toBe(0);
    expect(credits.resetToDefaults).toHaveBeenCalledTimes(1);
  });
});
