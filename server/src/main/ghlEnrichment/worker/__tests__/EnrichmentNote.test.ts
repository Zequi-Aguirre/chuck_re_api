import { EnrichmentResult } from "../../../types/LeadEnrichment";
import { buildEnrichmentNote, ENRICHMENT_NOTE_HEADING } from "../EnrichmentNote";

const result = (over: Partial<EnrichmentResult> = {}): EnrichmentResult => ({
  ownerName: "Jane Homeowner",
  isActiveListed: false,
  lastSalePrice: 250000,
  lastSoldDate: "2019-05-01",
  mortgageAmount: 180000,
  foreclosureActive: false,
  disqualify: false,
  disqualifyReasons: [],
  ...over,
});

describe("buildEnrichmentNote", () => {
  it("renders the heading plus every present field", () => {
    const note = buildEnrichmentNote(result());
    expect(note.startsWith(ENRICHMENT_NOTE_HEADING)).toBe(true);
    expect(note).toContain("Owner: Jane Homeowner");
    expect(note).toContain("Actively listed: No");
    expect(note).toContain("Last sale: $250,000 on 2019-05-01");
    expect(note).toContain("Open mortgage: $180,000");
    expect(note).toContain("Foreclosure: None");
  });

  it("omits owner/sale/mortgage lines when their values are absent", () => {
    const note = buildEnrichmentNote(
      result({ ownerName: null, lastSalePrice: null, lastSoldDate: null, mortgageAmount: null })
    );
    expect(note).not.toContain("Owner:");
    expect(note).not.toContain("Last sale:");
    expect(note).not.toContain("Open mortgage:");
    // Boolean signals are always shown — both true and false are meaningful.
    expect(note).toContain("Actively listed: No");
    expect(note).toContain("Foreclosure: None");
  });

  it("surfaces disqualification with reasons first", () => {
    const note = buildEnrichmentNote(
      result({ disqualify: true, disqualifyReasons: ["ADDRESS_MISMATCH", " "] })
    );
    const lines = note.split("\n");
    expect(lines[0]).toBe(ENRICHMENT_NOTE_HEADING);
    expect(lines[1]).toBe("⚠️ Disqualified: ADDRESS_MISMATCH");
  });

  it("shows a bare disqualified line when no reasons are given", () => {
    const note = buildEnrichmentNote(result({ disqualify: true, disqualifyReasons: [] }));
    expect(note).toContain("⚠️ Disqualified");
    expect(note).not.toContain("Disqualified:");
  });

  it("shows active listing and foreclosure when true", () => {
    const note = buildEnrichmentNote(result({ isActiveListed: true, foreclosureActive: true }));
    expect(note).toContain("Actively listed: Yes");
    expect(note).toContain("Foreclosure: Active");
  });

  it("falls back to a sold-date line when the price is missing", () => {
    const note = buildEnrichmentNote(result({ lastSalePrice: null, lastSoldDate: "2020-01-02" }));
    expect(note).toContain("Last sold: 2020-01-02");
    expect(note).not.toContain("Last sale:");
  });

  it("never leaks anything but enrichment output (no credentials)", () => {
    const note = buildEnrichmentNote(result());
    expect(note.toLowerCase()).not.toContain("bearer");
    expect(note.toLowerCase()).not.toContain("api");
  });
});
