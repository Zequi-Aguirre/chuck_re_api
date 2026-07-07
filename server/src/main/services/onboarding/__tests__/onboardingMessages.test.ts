import {
  buildProfileAck,
  buildIntroMessage,
  parseProfileReply,
} from "../onboardingMessages";

/** No message these builders produce may contain an emoji (the no-emoji rule). */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;

describe("buildIntroMessage (JAK-silent-credits-intro)", () => {
  it("is a clean greeting that just invites an address", () => {
    expect(buildIntroMessage()).toBe(
      "Hey, this is Jake. Text me any address and I'll tell you everything about it."
    );
  });

  it("NEVER mentions credits, balances, or grant numbers", () => {
    const msg = buildIntroMessage().toLowerCase();
    expect(msg).not.toContain("credit");
    expect(msg).not.toContain("balance");
    expect(msg).not.toMatch(/\d/); // no seeded 50/10/10 or any number
  });

  it("does NOT ask for name/email on the first text (the ask is delayed)", () => {
    const msg = buildIntroMessage().toLowerCase();
    expect(msg).not.toContain("name");
    expect(msg).not.toContain("email");
  });

  it("is emoji-free", () => {
    expect(EMOJI_RE.test(buildIntroMessage())).toBe(false);
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
