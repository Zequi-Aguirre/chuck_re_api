/**
 * JAK-196 — AddressLlmParser unit tests. The LLM seam is mocked (no network): we
 * assert the request shape, the JAK-193 re-validation of the model's output, that
 * structured hints win, and that every failure mode degrades to null (never throw,
 * never spend when the key is absent).
 */
import { mock, MockProxy } from "jest-mock-extended";
import { AddressLlmParser } from "../AddressLlmParser";
import { LlmClientResolver } from "../../../services/llm/LlmClientResolver";
import { LlmClient } from "../../../services/llm/LlmClient";

const client = (over: Partial<LlmClient> = {}): MockProxy<LlmClient> => {
  const c = mock<LlmClient>();
  Object.defineProperty(c, "isAvailable", { get: () => over.isAvailable ?? true });
  return c;
};

const reply = (obj: Record<string, unknown>): string => JSON.stringify(obj);

describe("AddressLlmParser", () => {
  let resolver: MockProxy<LlmClientResolver>;
  let llm: MockProxy<LlmClient>;
  let parser: AddressLlmParser;

  beforeEach(() => {
    resolver = mock<LlmClientResolver>();
    llm = client();
    resolver.resolve.mockReturnValue(llm);
    parser = new AddressLlmParser(resolver);
  });

  it("parses a no-comma blob into clean parts and re-validates via JAK-193 rules", async () => {
    llm.generateStructured.mockResolvedValue(
      reply({ house: "828", street: "Pearson Oaks Dr", city: "collierville", state: "TN", zip: "38017" })
    );

    const parts = await parser.parse("828 Pearson Oaks Dr collierville TN 38017");

    expect(parts).toEqual({
      house: "828",
      street: "Pearson Oaks Dr",
      city: "collierville",
      state: "TN",
      zip: "38017",
    });
    // The raw line is sent as the user turn under the address_parse schema.
    const [req] = llm.generateStructured.mock.calls[0];
    expect(req.user).toBe("828 Pearson Oaks Dr collierville TN 38017");
    expect(req.schemaName).toBe("address_parse");
  });

  it("derives the state from the zip when the model leaves it blank (JAK-193)", async () => {
    llm.generateStructured.mockResolvedValue(
      reply({ house: "3165", street: "Tracy Rd", city: "atoka", state: "", zip: "38004" })
    );

    const parts = await parser.parse("3165 Tracy Rd atoka 38004");

    expect(parts).toMatchObject({ house: "3165", street: "Tracy Rd", state: "TN", zip: "38004" });
  });

  it("structured HINTS win over the model's guess", async () => {
    llm.generateStructured.mockResolvedValue(
      reply({ house: "828", street: "Pearson Oaks Dr", city: "WRONG", state: "CA", zip: "99999" })
    );

    const parts = await parser.parse("828 Pearson Oaks Dr ...", {
      city: "collierville",
      state: "TN",
      postal: "38017",
    });

    expect(parts).toEqual({
      house: "828",
      street: "Pearson Oaks Dr",
      city: "collierville",
      state: "TN",
      zip: "38017",
    });
  });

  it("returns null WITHOUT calling the model when no key is configured", async () => {
    resolver.resolve.mockReturnValue(client({ isAvailable: false }));
    const p = new AddressLlmParser(resolver);

    expect(await p.parse("828 Pearson Oaks Dr collierville TN 38017")).toBeNull();
  });

  it("returns null when the model errors (timeout / provider failure)", async () => {
    llm.generateStructured.mockRejectedValue(new Error("timeout"));
    expect(await parser.parse("anything")).toBeNull();
  });

  it("returns null on non-JSON / malformed output", async () => {
    llm.generateStructured.mockResolvedValue("not json at all");
    expect(await parser.parse("anything")).toBeNull();
  });

  it("returns null when the model omits the house number (fails partsFromFields)", async () => {
    llm.generateStructured.mockResolvedValue(
      reply({ house: "", street: "Pearson Oaks Dr", city: "collierville", state: "TN", zip: "38017" })
    );
    expect(await parser.parse("Pearson Oaks Dr collierville TN 38017")).toBeNull();
  });

  it("returns null when there is no usable zip anywhere (JAK-193 invariant)", async () => {
    llm.generateStructured.mockResolvedValue(
      reply({ house: "828", street: "Pearson Oaks Dr", city: "collierville", state: "TN", zip: "" })
    );
    expect(await parser.parse("828 Pearson Oaks Dr collierville TN")).toBeNull();
  });
});
