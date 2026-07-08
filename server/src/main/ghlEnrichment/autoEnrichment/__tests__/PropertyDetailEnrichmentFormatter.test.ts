import {
  extractEnrichmentSubject,
  formatPropertyDetailEnrichment,
} from "../PropertyDetailEnrichmentFormatter";
import {
  AutoEnrichmentFields,
  ReapiPropertyDetailSubject,
} from "../AutoEnrichmentTypes";

/** A fixed reference "now" so the NEXT-UPCOMING auction rule is deterministic. */
const NOW = new Date("2026-07-08T00:00:00.000Z");
const opts = { referenceDate: NOW };

/** A richly-populated subject; individual tests override just what they exercise. */
const fullSubject = (
  overrides: Partial<ReapiPropertyDetailSubject> = {}
): ReapiPropertyDetailSubject => ({
  preForeclosure: true,
  auction: false,
  taxLien: true,
  lien: false,
  bankOwned: false,
  vacant: true,
  inherited: false,
  death: false,
  deathTransfer: false,
  highEquity: true,
  freeClear: false,
  outOfStateAbsenteeOwner: true,
  inStateAbsenteeOwner: false,
  absenteeOwner: true,
  corporateOwned: false,
  investorBuyer: false,
  cashBuyer: false,
  mobileHome: false,
  MFH2to4: false,
  MFH5plus: false,
  mlsActive: false,
  mlsStatus: "Sold",
  propertyType: "SFR",
  estimatedEquity: 275000,
  equityPercent: 62,
  estimatedValue: 440000,
  openMortgageBalance: 165000,
  estimatedMortgageBalance: 170000,
  estimatedMortgagePayment: 1450,
  ownerInfo: {
    owner1FullName: "Jane Q. Homeowner",
    companyName: "Homeowner Holdings LLC",
    ownerNames: ["Jane Q. Homeowner", "John Homeowner"],
    ownershipLength: 182,
  },
  propertyInfo: {
    address: { label: "123 Main St, Austin, TX 78701" },
    bedrooms: 3,
    bathrooms: 2,
    livingSquareFeet: 1850,
    buildingSquareFeet: 2000,
    lotSquareFeet: 6500,
    yearBuilt: 1998,
  },
  lotInfo: { lotSquareFeet: 7200 },
  lastSaleDate: "2011-05-01",
  lastSalePrice: 210000,
  lastSale: { saleDate: "2011-05-01", saleAmount: 210000 },
  ...overrides,
});

const format = (
  overrides: Partial<ReapiPropertyDetailSubject> = {}
): AutoEnrichmentFields => formatPropertyDetailEnrichment(fullSubject(overrides), opts);

describe("formatPropertyDetailEnrichment", () => {
  it("maps a fully-populated subject to every logical field", () => {
    expect(format()).toEqual({
      dealSignals:
        "Pre-Foreclosure\nTax Lien\nVacant\nHigh Equity\nOut-of-State Absentee\nAbsentee Owner",
      mlsStatus: "Off Market",
      propertyType: "SFR",
      estimatedEquity: 275000,
      equityPercent: 62,
      estimatedValue: 440000,
      mortgageBalance: 165000,
      monthlyMortgage: 1450,
      ownerOfRecord: "Jane Q. Homeowner",
      yearsOwned: "15.2 Years",
      beds: 3,
      baths: 2,
      sqFt: 1850,
      lotSize: 7200,
      yearBuilt: 1998,
      lastSaleDate: "2011-05-01",
      lastSalePrice: 210000,
      propertyAddress: "123 Main St, Austin, TX 78701",
    });
  });

  describe("deal signals", () => {
    it("omits the field entirely when no signal is true", () => {
      const allFalse: Partial<ReapiPropertyDetailSubject> = {};
      for (const key of [
        "preForeclosure",
        "auction",
        "taxLien",
        "lien",
        "bankOwned",
        "vacant",
        "inherited",
        "death",
        "deathTransfer",
        "highEquity",
        "freeClear",
        "outOfStateAbsenteeOwner",
        "inStateAbsenteeOwner",
        "absenteeOwner",
        "corporateOwned",
        "investorBuyer",
        "cashBuyer",
        "mobileHome",
        "MFH2to4",
        "MFH5plus",
      ] as const) {
        (allFalse as Record<string, unknown>)[key] = false;
      }
      expect(format(allFalse)).not.toHaveProperty("dealSignals");
    });

    it("emits signals in PRIORITY order regardless of which are set", () => {
      const result = format({
        // set every signal true to lock the full priority ordering
        preForeclosure: true,
        auction: false,
        taxLien: true,
        lien: true,
        bankOwned: true,
        vacant: true,
        inherited: true,
        death: true,
        deathTransfer: true,
        highEquity: true,
        freeClear: true,
        outOfStateAbsenteeOwner: true,
        inStateAbsenteeOwner: true,
        absenteeOwner: true,
        corporateOwned: true,
        investorBuyer: true,
        cashBuyer: true,
        mobileHome: true,
        MFH2to4: true,
        MFH5plus: true,
      });
      expect(result.dealSignals).toBe(
        [
          "Pre-Foreclosure",
          "Tax Lien",
          "Lien",
          "Bank Owned",
          "Vacant",
          "Inherited",
          "Death",
          "Death Transfer",
          "High Equity",
          "Free & Clear",
          "Out-of-State Absentee",
          "In-State Absentee",
          "Absentee Owner",
          "Corporate Owned",
          "Investor Buyer",
          "Cash Buyer",
          "Mobile Home",
          "MFH 2-4",
          "MFH 5+",
        ].join("\n")
      );
    });

    it("treats only literal boolean true as on (not truthy strings/1)", () => {
      const result = format({
        preForeclosure: "true" as unknown as boolean,
        taxLien: 1 as unknown as boolean,
        vacant: false,
        highEquity: false,
        outOfStateAbsenteeOwner: false,
        absenteeOwner: false,
      });
      expect(result).not.toHaveProperty("dealSignals");
    });

    it("Auction with a single future date renders the date", () => {
      const result = format({
        auction: true,
        foreclosureInfo: [{ auctionDate: "2026-08-15" }],
      });
      expect(result.dealSignals).toContain("Auction: 08/15/2026");
    });

    it("Auction true with no date renders a bare 'Auction'", () => {
      const result = format({ auction: true, foreclosureInfo: [] });
      expect(result.dealSignals?.split("\n")).toContain("Auction");
      expect(result.dealSignals).not.toContain("Auction:");
    });

    it("Auction with no foreclosureInfo at all renders a bare 'Auction'", () => {
      const result = format({ auction: true, foreclosureInfo: undefined });
      expect(result.dealSignals?.split("\n")).toContain("Auction");
    });

    it("Auction with multiple records uses the NEXT UPCOMING date", () => {
      const result = format({
        auction: true,
        foreclosureInfo: [
          { auctionDate: "2027-01-10" }, // upcoming, later
          { auctionDate: "2025-02-01" }, // past
          { auctionDate: "2026-09-30" }, // upcoming, earliest → chosen
        ],
      });
      expect(result.dealSignals).toContain("Auction: 09/30/2026");
    });

    it("Auction where all records are past uses the most recent past date", () => {
      const result = format({
        auction: true,
        foreclosureInfo: [
          { auctionDate: "2020-02-01" },
          { auctionDate: "2024-11-20" }, // most recent past → chosen
          { auctionDate: "2019-06-15" },
        ],
      });
      expect(result.dealSignals).toContain("Auction: 11/20/2024");
    });

    it("a date on the reference day itself counts as upcoming", () => {
      const result = format({
        auction: true,
        foreclosureInfo: [{ auctionDate: "2026-07-08" }, { auctionDate: "2020-01-01" }],
      });
      expect(result.dealSignals).toContain("Auction: 07/08/2026");
    });

    it("normalizes an ISO datetime auction value and ignores unparseable ones", () => {
      const result = format({
        auction: true,
        foreclosureInfo: [
          { auctionDate: "not-a-date" },
          { auctionDate: "2026-12-01T00:00:00.000Z" },
        ],
      });
      expect(result.dealSignals).toContain("Auction: 12/01/2026");
    });

    it("places the Auction line in its #2 priority slot", () => {
      const result = format({
        preForeclosure: true,
        auction: true,
        foreclosureInfo: [{ auctionDate: "2026-08-15" }],
        taxLien: true,
        vacant: false,
        highEquity: false,
        outOfStateAbsenteeOwner: false,
        absenteeOwner: false,
      });
      expect(result.dealSignals).toBe(
        "Pre-Foreclosure\nAuction: 08/15/2026\nTax Lien"
      );
    });
  });

  describe("MLS status", () => {
    it("is Listed when mlsActive is true", () => {
      expect(format({ mlsActive: true, mlsStatus: null }).mlsStatus).toBe("Listed");
    });

    it.each(["Active", "Pending", "Coming Soon", "Active Under Contract", "Contingent"])(
      "is Listed for currently-listed status %s",
      (status) => {
        expect(format({ mlsActive: false, mlsStatus: status }).mlsStatus).toBe("Listed");
      }
    );

    it.each(["Sold", "Closed", "Expired", "Withdrawn", "Cancelled", "Off Market"])(
      "is Off Market for non-listed status %s",
      (status) => {
        expect(format({ mlsActive: false, mlsStatus: status }).mlsStatus).toBe(
          "Off Market"
        );
      }
    );

    it("defaults to Off Market when no MLS signals are present", () => {
      expect(format({ mlsActive: null, mlsStatus: null }).mlsStatus).toBe("Off Market");
    });
  });

  describe("years owned", () => {
    it.each([
      [182, "15.2 Years"],
      [120, "10.0 Years"],
      [18, "1.5 Years"],
      [6, "0.5 Years"],
      [0, "0.0 Years"],
    ])("converts %d months to %s", (months, expected) => {
      expect(format({ ownerInfo: { ownershipLength: months } }).yearsOwned).toBe(expected);
    });

    it("accepts a numeric string month count", () => {
      expect(format({ ownerInfo: { ownershipLength: "182" } }).yearsOwned).toBe("15.2 Years");
    });

    it("omits when ownershipLength is missing", () => {
      expect(format({ ownerInfo: {} })).not.toHaveProperty("yearsOwned");
    });
  });

  describe("owner of record fallbacks", () => {
    it("prefers owner1FullName", () => {
      expect(format().ownerOfRecord).toBe("Jane Q. Homeowner");
    });

    it("falls back to companyName", () => {
      expect(
        format({
          ownerInfo: { companyName: "Acme LLC", ownerNames: ["Ignored"] },
        }).ownerOfRecord
      ).toBe("Acme LLC");
    });

    it("falls back to ownerNames[0]", () => {
      expect(
        format({ ownerInfo: { ownerNames: ["First Owner", "Second"] } }).ownerOfRecord
      ).toBe("First Owner");
    });

    it("skips blank owner1FullName and uses the next non-empty fallback", () => {
      expect(
        format({ ownerInfo: { owner1FullName: "   ", companyName: "Fallback Co" } })
          .ownerOfRecord
      ).toBe("Fallback Co");
    });

    it("omits when no owner name is present", () => {
      expect(format({ ownerInfo: {} })).not.toHaveProperty("ownerOfRecord");
    });
  });

  describe("numeric + fallback fields", () => {
    it("mortgageBalance prefers openMortgageBalance, falls back to estimated", () => {
      expect(format({ openMortgageBalance: 99000 }).mortgageBalance).toBe(99000);
      expect(
        format({ openMortgageBalance: null, estimatedMortgageBalance: 170000 })
          .mortgageBalance
      ).toBe(170000);
    });

    it("sqFt prefers livingSquareFeet, falls back to buildingSquareFeet", () => {
      expect(format().sqFt).toBe(1850);
      expect(
        format({
          propertyInfo: { livingSquareFeet: null, buildingSquareFeet: 2100 },
        }).sqFt
      ).toBe(2100);
    });

    it("lotSize prefers lotInfo.lotSquareFeet, falls back to propertyInfo.lotSquareFeet", () => {
      expect(format().lotSize).toBe(7200);
      expect(
        format({ lotInfo: undefined, propertyInfo: { lotSquareFeet: 6500 } }).lotSize
      ).toBe(6500);
    });

    it("lastSalePrice/date fall back to the lastSale block", () => {
      const result = format({
        lastSaleDate: null,
        lastSalePrice: null,
        lastSale: { saleDate: "2009-03-14", saleAmount: 185000 },
      });
      expect(result.lastSaleDate).toBe("2009-03-14");
      expect(result.lastSalePrice).toBe(185000);
    });

    it("coerces numeric strings and strips $/commas", () => {
      const result = format({ estimatedValue: "$1,250,000", equityPercent: "48" });
      expect(result.estimatedValue).toBe(1250000);
      expect(result.equityPercent).toBe(48);
    });

    it("keeps a legitimate zero value", () => {
      expect(format({ estimatedEquity: 0 }).estimatedEquity).toBe(0);
    });

    it("omits non-finite / unparseable numbers", () => {
      const result = format({
        estimatedEquity: Number.NaN,
        estimatedValue: "n/a",
        equityPercent: null,
      });
      expect(result).not.toHaveProperty("estimatedEquity");
      expect(result).not.toHaveProperty("estimatedValue");
      expect(result).not.toHaveProperty("equityPercent");
    });
  });

  describe("missing / empty handling", () => {
    it("returns only mlsStatus for an empty subject", () => {
      expect(formatPropertyDetailEnrichment({}, opts)).toEqual({ mlsStatus: "Off Market" });
    });

    it("omits string fields that are blank", () => {
      const result = format({
        propertyType: "   ",
        propertyInfo: { address: { label: "" } },
      });
      expect(result).not.toHaveProperty("propertyType");
      expect(result).not.toHaveProperty("propertyAddress");
    });

    it("tolerates null nested blocks", () => {
      const result = formatPropertyDetailEnrichment(
        { ownerInfo: null, propertyInfo: null, lotInfo: null, lastSale: null },
        opts
      );
      expect(result).toEqual({ mlsStatus: "Off Market" });
    });

    it("emits no emoji in any string value", () => {
      const result = format({ auction: true, foreclosureInfo: [{ auctionDate: "2026-08-15" }] });
      const strings = Object.values(result).filter((v) => typeof v === "string");
      const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
      for (const s of strings) expect(s).not.toMatch(emoji);
    });
  });
});

describe("extractEnrichmentSubject", () => {
  it("unwraps the { data } envelope", () => {
    const subject = { propertyType: "SFR" };
    expect(extractEnrichmentSubject({ data: subject })).toBe(subject);
  });

  it("unwraps a { subject } alias", () => {
    const subject = { propertyType: "SFR" };
    expect(extractEnrichmentSubject({ subject })).toBe(subject);
  });

  it("returns a bare subject unchanged", () => {
    const subject = { propertyType: "SFR" };
    expect(extractEnrichmentSubject(subject)).toBe(subject);
  });

  it("returns undefined for null / non-object input", () => {
    expect(extractEnrichmentSubject(null)).toBeUndefined();
    expect(extractEnrichmentSubject(undefined)).toBeUndefined();
  });

  it("composes with the formatter end-to-end", () => {
    const subject = extractEnrichmentSubject({ data: { propertyType: "Condo" } });
    expect(subject).toBeDefined();
    expect(formatPropertyDetailEnrichment(subject!, opts).propertyType).toBe("Condo");
  });
});
