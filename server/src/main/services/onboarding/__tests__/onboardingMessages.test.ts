import {
  buildProfileAck,
  buildWelcomeMessage,
  parseProfileReply,
} from "../onboardingMessages";

/** No message these builders produce may contain an emoji (the no-emoji rule). */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;

describe("buildWelcomeMessage (JAK-first-text-welcome)", () => {
  it("announces the three seeded grants with clean pluralization", () => {
    const msg = buildWelcomeMessage({ report: 50, skiptrace: 10, comps: 10 });
    expect(msg).toContain("Welcome to Jake.");
    expect(msg).toContain("50 report credits");
    expect(msg).toContain("10 skip trace credits");
    expect(msg).toContain("10 comps credits");
  });

  it("uses the LIVE grant numbers, not hardcoded ones", () => {
    const msg = buildWelcomeMessage({ report: 25, skiptrace: 3, comps: 7 });
    expect(msg).toContain("25 report credits");
    expect(msg).toContain("3 skip trace credits");
    expect(msg).toContain("7 comps credits");
    expect(msg).not.toContain("50 report");
  });

  it("singularizes a grant of 1", () => {
    expect(buildWelcomeMessage({ report: 1, skiptrace: 1, comps: 10 })).toContain("1 report credit,");
  });

  it("does NOT ask for name/email on the first text (the ask is delayed)", () => {
    const msg = buildWelcomeMessage({ report: 50, skiptrace: 10, comps: 10 }).toLowerCase();
    expect(msg).not.toContain("name");
    expect(msg).not.toContain("email");
  });

  it("is emoji-free", () => {
    expect(EMOJI_RE.test(buildWelcomeMessage({ report: 50, skiptrace: 10, comps: 10 }))).toBe(false);
  });
});

describe("buildProfileAck (JAK-first-text-welcome)", () => {
  it("greets by first name when we captured one, emoji-free", () => {
    const ack = buildProfileAck({ firstName: "Sara" });
    expect(ack).toContain("Sara");
    expect(ack.toLowerCase()).toContain("saved your info");
    expect(EMOJI_RE.test(ack)).toBe(false);
  });

  it("is still friendly with only an email captured", () => {
    expect(buildProfileAck({ email: "sara@example.com" }).toLowerCase()).toContain("thanks");
  });
});

describe("parseProfileReply (JAK-first-text-welcome)", () => {
  it("pulls first, last and email out of a natural reply", () => {
    expect(parseProfileReply("Sara Kim, sara@example.com")).toEqual({
      firstName: "Sara",
      lastName: "Kim",
      email: "sara@example.com",
    });
  });

  it("handles conversational framing around the name and email", () => {
    expect(parseProfileReply("my name is Sara Kim and my email is sara@example.com")).toEqual({
      firstName: "Sara",
      lastName: "Kim",
      email: "sara@example.com",
    });
  });

  it("captures a name-only reply when it carries an explicit cue", () => {
    expect(parseProfileReply("I'm Sara Kim")).toEqual({ firstName: "Sara", lastName: "Kim" });
  });

  it("captures an email-only reply", () => {
    expect(parseProfileReply("sara@example.com")).toEqual({ email: "sara@example.com" });
  });

  it("returns null for an address or a command (never hijacks real usage)", () => {
    expect(parseProfileReply("123 Main St, Springfield, IL 62704")).toBeNull();
    expect(parseProfileReply("skip trace 742 Evergreen Terrace")).toBeNull();
    expect(parseProfileReply("the 2nd one")).toBeNull();
    expect(parseProfileReply("OK")).toBeNull();
    expect(parseProfileReply("")).toBeNull();
  });
});
