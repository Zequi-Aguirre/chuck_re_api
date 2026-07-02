import bcrypt from "bcryptjs";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { AdminAuthService } from "../AdminAuthService";
import { AdminUserStore } from "../AdminUserStore";
import { AdminUserRow } from "../AdminTypes";

// Obviously-fake, low-entropy placeholder. NOT a real credential.
const FAKE_JWT_SECRET = "unit-test-jwt-signing-value";

const row = (over: Partial<AdminUserRow> = {}): AdminUserRow => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  password_hash: bcrypt.hashSync("correct horse battery", 4),
  created_at: new Date("2026-07-01T00:00:00Z"),
  updated_at: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const env = (over: Partial<EnvConfig> = {}): EnvConfig =>
  ({
    jwtSecret: FAKE_JWT_SECRET,
    adminSessionTtlHours: 12,
    adminSeedEmail: "",
    adminSeedPassword: "",
    ...over,
  }) as EnvConfig;

describe("AdminAuthService", () => {
  let users: MockProxy<AdminUserStore>;

  beforeEach(() => {
    users = mock<AdminUserStore>();
  });

  describe("verifyCredentials", () => {
    it("returns the admin (without the hash) on a correct password", async () => {
      users.findByEmail.mockResolvedValue(row());
      const service = new AdminAuthService(users, env());

      const user = await service.verifyCredentials("admin@example.com", "correct horse battery");

      expect(user).not.toBeNull();
      expect(user?.email).toBe("admin@example.com");
      // The safe identity never carries the hash.
      expect((user as unknown as Record<string, unknown>).password_hash).toBeUndefined();
    });

    it("returns null on a wrong password", async () => {
      users.findByEmail.mockResolvedValue(row());
      const service = new AdminAuthService(users, env());
      expect(await service.verifyCredentials("admin@example.com", "wrong")).toBeNull();
    });

    it("returns null for an unknown email (and still runs a compare)", async () => {
      users.findByEmail.mockResolvedValue(null);
      const service = new AdminAuthService(users, env());
      expect(await service.verifyCredentials("nobody@example.com", "whatever")).toBeNull();
    });
  });

  describe("token round-trip", () => {
    it("issues a JWT that verifies back to the same admin", async () => {
      const service = new AdminAuthService(users, env());
      const token = service.issueToken({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        email: "admin@example.com",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const payload = service.verifyToken(token);
      expect(payload?.sub).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(payload?.email).toBe("admin@example.com");
    });

    it("rejects a token signed with a different secret", async () => {
      const issuer = new AdminAuthService(users, env());
      const token = issuer.issueToken({
        id: "id",
        email: "a@b.co",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const otherVerifier = new AdminAuthService(users, env({ jwtSecret: "other-unit-test-value" }));
      expect(otherVerifier.verifyToken(token)).toBeNull();
    });

    it("rejects garbage", async () => {
      const service = new AdminAuthService(users, env());
      expect(service.verifyToken("not.a.jwt")).toBeNull();
    });
  });

  describe("seedFirstAdmin", () => {
    it("skips when the seed env is not set", async () => {
      const service = new AdminAuthService(users, env());
      expect(await service.seedFirstAdmin()).toBe("skipped");
      expect(users.insert).not.toHaveBeenCalled();
    });

    it("creates the first admin, hashing the password", async () => {
      users.findByEmail.mockResolvedValue(null);
      users.insert.mockResolvedValue(row());
      const service = new AdminAuthService(
        users,
        env({ adminSeedEmail: "Admin@Example.com", adminSeedPassword: "unit-test-seed-pw" })
      );

      expect(await service.seedFirstAdmin()).toBe("created");
      const [email, hash] = users.insert.mock.calls[0];
      expect(email).toBe("admin@example.com"); // normalized to lowercase
      // Never the plaintext — a bcrypt hash that verifies.
      expect(hash).not.toBe("unit-test-seed-pw");
      expect(bcrypt.compareSync("unit-test-seed-pw", hash)).toBe(true);
    });

    it("does not re-create or overwrite an existing admin", async () => {
      users.findByEmail.mockResolvedValue(row());
      const service = new AdminAuthService(
        users,
        env({ adminSeedEmail: "admin@example.com", adminSeedPassword: "pw" })
      );
      expect(await service.seedFirstAdmin()).toBe("exists");
      expect(users.insert).not.toHaveBeenCalled();
    });
  });
});
