import { mock, MockProxy } from "jest-mock-extended";
import { FooterService } from "../FooterService";
import { FooterStore } from "../FooterStore";
import { PropertyReportWriter } from "../../PropertyReportWriter";
import { FooterRow } from "../FooterTypes";
import { applyChosenFooter } from "../footerText";

const row = (over: Partial<FooterRow> = {}): FooterRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  text: "Footer A",
  active: true,
  created_at: new Date("2026-07-01T00:00:00Z"),
  updated_at: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

describe("FooterService.getRandomActiveFooter", () => {
  let store: MockProxy<FooterStore>;
  let service: FooterService;

  beforeEach(() => {
    store = mock<FooterStore>();
    service = new FooterService(store);
  });

  afterEach(() => jest.restoreAllMocks());

  it("returns the text of an active footer", async () => {
    store.listActive.mockResolvedValue([row({ id: "a", text: "Only Active Footer" })]);
    expect(await service.getRandomActiveFooter()).toBe("Only Active Footer");
  });

  it("only ever returns one of the ACTIVE footers", async () => {
    const actives = [row({ id: "a", text: "A" }), row({ id: "b", text: "B" }), row({ id: "c", text: "C" })];
    store.listActive.mockResolvedValue(actives);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(await service.getRandomActiveFooter());
    for (const s of seen) expect(["A", "B", "C"]).toContain(s);
  });

  it("picks uniformly by index (drives Math.random across the range)", async () => {
    store.listActive.mockResolvedValue([
      row({ text: "first" }),
      row({ text: "second" }),
      row({ text: "third" }),
    ]);
    // Math.random in [0,1) → index floor(r*3): 0 → first, ~0.5 → second, ~0.99 → third.
    const rand = jest.spyOn(Math, "random");
    rand.mockReturnValue(0);
    expect(await service.getRandomActiveFooter()).toBe("first");
    rand.mockReturnValue(0.5);
    expect(await service.getRandomActiveFooter()).toBe("second");
    rand.mockReturnValue(0.999);
    expect(await service.getRandomActiveFooter()).toBe("third");
  });

  it("falls back to the hardcoded default footer when NONE are active", async () => {
    store.listActive.mockResolvedValue([]);
    expect(await service.getRandomActiveFooter()).toBe(PropertyReportWriter.FOOTER);
    expect(FooterService.DEFAULT_FOOTER).toBe(PropertyReportWriter.FOOTER);
  });
});

describe("FooterService CRUD", () => {
  let store: MockProxy<FooterStore>;
  let service: FooterService;

  beforeEach(() => {
    store = mock<FooterStore>();
    service = new FooterService(store);
  });

  it("lists footers mapped to the camelCase shape", async () => {
    store.listAll.mockResolvedValue([row({ id: "x", text: "T", active: false })]);
    const list = await service.list();
    expect(list).toEqual([
      {
        id: "x",
        text: "T",
        active: false,
        createdAt: new Date("2026-07-01T00:00:00Z"),
        updatedAt: new Date("2026-07-01T00:00:00Z"),
      },
    ]);
  });

  it("creates a footer active-by-default", async () => {
    store.insert.mockImplementation(async (text, active) => row({ text, active }));
    const created = await service.create({ text: "New footer" });
    expect(store.insert).toHaveBeenCalledWith("New footer", true);
    expect(created.active).toBe(true);
    expect(created.text).toBe("New footer");
  });

  it("creates an inactive footer when asked", async () => {
    store.insert.mockImplementation(async (text, active) => row({ text, active }));
    const created = await service.create({ text: "Parked", active: false });
    expect(store.insert).toHaveBeenCalledWith("Parked", false);
    expect(created.active).toBe(false);
  });

  it("updates text/active and returns the mapped footer", async () => {
    store.update.mockResolvedValue(row({ id: "x", text: "Edited", active: false }));
    const updated = await service.update("x", { text: "Edited", active: false });
    expect(store.update).toHaveBeenCalledWith("x", { text: "Edited", active: false });
    expect(updated).toMatchObject({ id: "x", text: "Edited", active: false });
  });

  it("returns null updating an unknown footer", async () => {
    store.update.mockResolvedValue(null);
    expect(await service.update("missing", { active: true })).toBeNull();
  });

  it("removes a footer", async () => {
    store.delete.mockResolvedValue(true);
    expect(await service.remove("x")).toBe(true);
    expect(store.delete).toHaveBeenCalledWith("x");
  });
});

describe("applyChosenFooter (sender swap)", () => {
  const DEFAULT = PropertyReportWriter.FOOTER;

  it("swaps a trailing default footer for the chosen one, preserving spacing", () => {
    const reply = `Here is your report.\n\n${DEFAULT}`;
    const chosen = "Custom footer line one\nCustom line two";
    expect(applyChosenFooter(reply, chosen, DEFAULT)).toBe(
      `Here is your report.\n\n${chosen}`
    );
  });

  it("is a no-op when the chosen footer IS the default", () => {
    const reply = `Body\n\n${DEFAULT}`;
    expect(applyChosenFooter(reply, DEFAULT, DEFAULT)).toBe(reply);
  });

  it("leaves a reply that does not end in the default footer untouched", () => {
    const ack = "On it — pulling that now.";
    expect(applyChosenFooter(ack, "Custom", DEFAULT)).toBe(ack);
  });

  it("only replaces the TRAILING footer, not an earlier mention", () => {
    const chosen = "Chosen";
    const reply = `${DEFAULT} (mentioned)\n\nBody\n\n${DEFAULT}`;
    expect(applyChosenFooter(reply, chosen, DEFAULT)).toBe(
      `${DEFAULT} (mentioned)\n\nBody\n\n${chosen}`
    );
  });
});
