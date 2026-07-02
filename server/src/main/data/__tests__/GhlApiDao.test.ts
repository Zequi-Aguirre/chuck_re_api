import axios from "axios";
import { GhlApiDao } from "../GhlApiDao";
import { EnvConfig } from "../../config/envConfig";
import { ExternalActionGuard } from "../../safety/ExternalActionGuard";
import { EnrichmentResult } from "../../types/LeadEnrichment";

jest.mock("axios");

/**
 * JAK-110 dev-safety proof for the parked MVP GHL client: off prod/staging no
 * write, tag, or SMS ever leaves the process; on prod/staging they hit the real
 * transport. Reads (getContact) are never gated.
 */
describe("GhlApiDao — outbound dev safety (JAK-110)", () => {
  const put = jest.fn();
  const post = jest.fn();
  const get = jest.fn();

  const env = {
    ghlBaseUrl: "https://services.leadconnectorhq.com",
    ghlApiKey: "test-key-not-real",
  } as unknown as EnvConfig;

  const guardWith = (live: boolean): ExternalActionGuard =>
    ({ liveActionsAllowed: live, echoSkipped: () => {} } as unknown as ExternalActionGuard);

  const RESULT: EnrichmentResult = {
    ownerName: "Owner",
    isActiveListed: true,
    lastSalePrice: 100,
    lastSoldDate: "2020-01-01",
    mortgageAmount: null,
    foreclosureActive: false,
    disqualify: false,
    disqualifyReasons: [],
  };

  beforeEach(() => {
    put.mockReset();
    post.mockReset();
    get.mockReset();
    (axios.create as jest.Mock).mockReturnValue({ put, post, get });
  });

  const daoFor = (live: boolean) => new GhlApiDao(env, guardWith(live));

  describe("dev (real actions OFF)", () => {
    it("echoes + SKIPS a custom-field write (no transport)", async () => {
      await daoFor(false).updateContactCustomFields("ct_1", RESULT);
      expect(put).not.toHaveBeenCalled();
    });

    it("echoes + SKIPS a tag apply (no transport)", async () => {
      await daoFor(false).applyTag("ct_1", "hot");
      expect(post).not.toHaveBeenCalled();
    });

    it("echoes + SKIPS an outbound SMS (never texts a real person)", async () => {
      const res = await daoFor(false).sendSms({ contactId: "ct_1", message: "hi" });
      expect(post).not.toHaveBeenCalled();
      expect(res).toBeNull();
    });
  });

  describe("prod / staging (real actions ON)", () => {
    it("performs the custom-field write in prod", async () => {
      put.mockResolvedValue({ data: {} });
      await daoFor(true).updateContactCustomFields("ct_1", RESULT);
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0][0]).toBe("/contacts/ct_1");
    });

    it("sends a real SMS in prod", async () => {
      post.mockResolvedValue({ data: { ok: true } });
      const res = await daoFor(true).sendSms({ contactId: "ct_1", message: "hi" });
      expect(post).toHaveBeenCalledTimes(1);
      expect(post.mock.calls[0][0]).toBe("/conversations/messages");
      expect(res).toEqual({ ok: true });
    });
  });

  it("allows reads (getContact) even in dev", async () => {
    get.mockResolvedValue({ data: { contact: { id: "ct_1" } } });
    const contact = await daoFor(false).getContact("ct_1");
    expect(get).toHaveBeenCalledTimes(1);
    expect(contact?.id).toBe("ct_1");
  });
});
