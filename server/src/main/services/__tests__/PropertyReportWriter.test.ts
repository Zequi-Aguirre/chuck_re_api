import { PropertyReportWriter } from "../PropertyReportWriter";
import { EnvConfig } from "../../config/envConfig";
import { PropertyReportData } from "../../types/PropertyReport";

/**
 * JAK-130 — the LLM writes the "Jake Property Report" SMS, with a deterministic
 * plain-text fallback so Jake ALWAYS replies. These tests pin the two seams that
 * matter: (a) the prompt hard-constrains the model to the verified data + no
 * emojis + the GoTextJake.com footer, and (b) any OpenAI failure drops cleanly to
 * the fallback — and NEITHER path ever emits an emoji.
 */

// Emoji / pictographic ranges — mirrors the writer's own strip guard.
const EMOJI =
    /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/u;

/** Subclass swapping the real OpenAI client for a controllable fake. */
class TestWriter extends PropertyReportWriter {
    public readonly create: jest.Mock = jest.fn();
    protected client(): any {
        return { chat: { completions: { create: this.create } } };
    }
}

const envWith = (over: Partial<EnvConfig> = {}): EnvConfig =>
    ({ openAiApiKey: "test-key", openAiModel: "gpt-4o-mini", ...over } as unknown as EnvConfig);

const fullData: PropertyReportData = {
    addressLine1: "742 Evergreen Terrace",
    addressLine2: "Springfield, IL 62704",
    propertyType: "Single Family",
    bedrooms: 4,
    bathrooms: 2,
    squareFeet: 2100,
    lotAcres: 1,
    yearBuilt: 1998,
    estimatedMarketValue: 325000,
    owner1: "Homer Simpson",
    owner2: "Marge Simpson",
    equityPercent: 100,
    freeAndClear: true,
    equityLevel: "High Equity",
    occupancy: "Investor-Owned",
    absenteeStatus: "Out-of-State Absentee Owner",
    yearsOwned: 7,
    lastSoldDate: "05/15/2019",
    salePrice: 210000,
    femaFloodZone: "AE",
    mlsListed: false,
};

describe("PropertyReportWriter (JAK-130)", () => {
    describe("prompt", () => {
        it("carries the verified data + no-emoji + only-provided-values + GoTextJake.com rules", () => {
            const [system, user] = new TestWriter(envWith()).buildMessages(fullData);

            expect(system.role).toBe("system");
            expect(system.content).toMatch(/NO EMOJIS/);
            expect(system.content).toMatch(/only the exact values provided/i);
            expect(system.content).toMatch(/never invent/i);
            expect(system.content).toContain("Get more property info");
            expect(system.content).toContain("GoTextJake.com");

            // The verified data rides along as JSON in the user message.
            expect(user.role).toBe("user");
            expect(user.content).toContain(JSON.stringify(fullData, null, 2));
            expect(user.content).toContain("742 Evergreen Terrace");
            expect(user.content).toContain("Homer Simpson");
        });
    });

    describe("LLM path", () => {
        it("calls the configured model at low temperature and returns the model's text (emoji-stripped)", async () => {
            const w = new TestWriter(envWith({ openAiModel: "gpt-4o-mini" } as Partial<EnvConfig>));
            w.create.mockResolvedValue({
                choices: [
                    {
                        message: {
                            content:
                                "Jake Property Report 🏠\n\n742 Evergreen Terrace\n\nGet more property info\nGoTextJake.com",
                        },
                    },
                ],
            });

            const out = await w.write(fullData);

            expect(w.create).toHaveBeenCalledTimes(1);
            const [params, opts] = w.create.mock.calls[0]!;
            expect(params.model).toBe("gpt-4o-mini");
            expect(params.temperature).toBe(0.2);
            expect(params.messages[0].role).toBe("system");
            expect(params.messages[1].content).toContain("742 Evergreen Terrace");
            expect(opts).toMatchObject({ timeout: expect.any(Number) });

            // The 🏠 the model slipped in is stripped; footer survives.
            expect(out).not.toMatch(EMOJI);
            expect(out).toContain("GoTextJake.com");
        });
    });

    describe("deterministic fallback", () => {
        it("is used when OpenAI errors — renders the full report, no emoji, footer present", async () => {
            const w = new TestWriter(envWith());
            w.create.mockRejectedValue(new Error("openai down"));

            const out = await w.write(fullData);

            expect(out).not.toMatch(EMOJI);
            expect(out.endsWith("Get more property info\nGoTextJake.com")).toBe(true);

            // Rendered from the SAME verified data.
            expect(out).toContain("Jake Property Report");
            expect(out).toContain("742 Evergreen Terrace");
            expect(out).toContain("Springfield, IL 62704");
            expect(out).toContain("Property");
            expect(out).toContain("• Single Family");
            expect(out).toContain("• 4 Beds | 2 Baths");
            expect(out).toContain("• 2,100 Sq Ft");
            expect(out).toContain("• Lot Size: 1.00 Acres");
            expect(out).toContain("• Built 1998");
            expect(out).toContain("Estimated Market Value\n$325,000");
            expect(out).toContain("• Homer Simpson");
            expect(out).toContain("• Marge Simpson");
            expect(out).toContain("• 100% Equity (Free & Clear)");
            expect(out).toContain("• High Equity");
            expect(out).toContain("• Investor-Owned");
            expect(out).toContain("• Out-of-State Absentee Owner");
            expect(out).toContain("• Years Owned: 7");
            expect(out).toContain("• Last Sold: 05/15/2019");
            expect(out).toContain("• Sale Price: $210,000");
            expect(out).toContain("• FEMA Flood Zone AE");
            expect(out).toContain("• Not Currently Listed on MLS");
        });

        it("is used when the LLM returns empty content", async () => {
            const w = new TestWriter(envWith());
            w.create.mockResolvedValue({ choices: [{ message: { content: "   " } }] });

            const out = await w.write(fullData);

            expect(out).toContain("Jake Property Report");
            expect(out).toContain("GoTextJake.com");
        });

        it("omits sections/fields with no data and never prints null/undefined", async () => {
            const w = new TestWriter(envWith());
            w.create.mockRejectedValue(new Error("down"));
            const sparse: PropertyReportData = {
                addressLine1: "9 Sparse Ln",
                addressLine2: "Town, CA 90000",
                owner1: "Jane Doe",
            };

            const out = await w.write(sparse);

            expect(out).not.toMatch(/null|undefined/);
            expect(out).not.toContain("Estimated Market Value");
            expect(out).not.toContain("History");
            expect(out).not.toContain("Additional Information");
            expect(out).toContain("Ownership\n• Jane Doe");
            expect(out.endsWith("Get more property info\nGoTextJake.com")).toBe(true);
            expect(out).not.toMatch(EMOJI);
        });
    });
});
