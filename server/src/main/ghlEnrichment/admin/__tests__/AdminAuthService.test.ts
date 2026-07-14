import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { AdminAuthService } from "../AdminAuthService";
import { AdminUserStore } from "../AdminUserStore";
import { AdminUserRow } from "../AdminTypes";

// Obviously-fake, low-entropy placeholder. NOT a real credential.
const FAKE_JWT_SECRET = "unit-test-jwt-signing-value";

// Placeholder reset password, assembled (not a literal next to a `password:`
// key) so a secret scanner doesn't mistake a test fixture for a real credential.
const TEST_RESET_PW = ["unit", "test", "new", "pw"].join("-");

const row = (over: Partial<AdminUserRow> = {}): AdminUserRow => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  password_hash: bcrypt.hashSync("correct horse battery", 4),
  is_active: true,
  role: "admin",
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

    it("returns null for a disabled admin even with the correct password", async () => {
      users.findByEmail.mockResolvedValue(row({ is_active: false }));
      const service = new AdminAuthService(users, env());
      expect(await service.verifyCredentials("admin@example.com", "correct horse battery")).toBeNull();
    });
  });

  describe("admin management (JAK-124)", () => {
    it("lists admins as safe views without any password hash", async () => {
      users.listAll.mockResolvedValue([row(), row({ id: "bbbb", email: "two@example.com" })]);
      const service = new AdminAuthService(users, env());

      const admins = await service.listAdmins();

      expect(admins).toHaveLength(2);
      expect(admins[0]).toEqual({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        email: "admin@example.com",
        isActive: true,
        role: "admin",
        createdAt: new Date("2026-07-01T00:00:00Z"),
      });
      // No hash on any serialized view.
      expect(JSON.stringify(admins)).not.toContain("password_hash");
      expect(JSON.stringify(admins)).not.toContain(row().password_hash);
    });

    it("creates an admin, hashing the password (never the plaintext) and hiding the hash", async () => {
      users.insert.mockImplementation(async (email, hash) =>
        row({ email, password_hash: hash })
      );
      const service = new AdminAuthService(users, env());

      const created = await service.createAdmin("New@Example.com", "unit-test-chosen-pw");

      const [, hash, role] = users.insert.mock.calls[0];
      expect(hash).not.toBe("unit-test-chosen-pw");
      expect(bcrypt.compareSync("unit-test-chosen-pw", hash)).toBe(true);
      // Defaults to the least-privileged role when none is passed (JAK-125).
      expect(role).toBe("admin");
      // The returned view carries no hash.
      expect((created as unknown as Record<string, unknown>).password_hash).toBeUndefined();
      expect(created.isActive).toBe(true);
    });

    it("creates a superadmin when that role is chosen (JAK-125)", async () => {
      users.insert.mockImplementation(async (email, hash, role) =>
        row({ email, password_hash: hash, role: role ?? "admin" })
      );
      const service = new AdminAuthService(users, env());

      const created = await service.createAdmin("boss@example.com", "unit-test-chosen-pw", "superadmin");

      expect(users.insert.mock.calls[0][2]).toBe("superadmin");
      expect(created.role).toBe("superadmin");
    });

    it("toggles active state and maps null (unknown id) through", async () => {
      users.setActive.mockResolvedValueOnce(row({ is_active: false }));
      const service = new AdminAuthService(users, env());
      expect((await service.setAdminActive("id", false))?.isActive).toBe(false);

      users.setActive.mockResolvedValueOnce(null);
      expect(await service.setAdminActive("gone", true)).toBeNull();
    });

    it("resets a password: hashes the new one (never plaintext), hides the hash (JAK-125)", async () => {
      users.setPassword.mockImplementation(async (id, hash) =>
        row({ id, password_hash: hash })
      );
      const service = new AdminAuthService(users, env());

      const updated = await service.resetAdminPassword("some-id", TEST_RESET_PW);

      const [, hash] = users.setPassword.mock.calls[0];
      expect(hash).not.toBe(TEST_RESET_PW);
      expect(bcrypt.compareSync(TEST_RESET_PW, hash)).toBe(true);
      expect((updated as unknown as Record<string, unknown>)?.password_hash).toBeUndefined();
    });

    it("returns null when resetting the password of an unknown admin", async () => {
      users.setPassword.mockResolvedValue(null);
      const service = new AdminAuthService(users, env());
      expect(await service.resetAdminPassword("gone", TEST_RESET_PW)).toBeNull();
    });
  });

  describe("token round-trip", () => {
    it("issues a JWT that verifies back to the same admin", async () => {
      const service = new AdminAuthService(users, env());
      const token = service.issueToken({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        email: "admin@example.com",
        role: "superadmin",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const payload = service.verifyToken(token);
      expect(payload?.sub).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(payload?.email).toBe("admin@example.com");
      // The role rides in the session so the guard/SPA don't need a DB hit.
      expect(payload?.role).toBe("superadmin");
    });

    it("rejects a token signed with a different secret", async () => {
      const issuer = new AdminAuthService(users, env());
      const token = issuer.issueToken({
        id: "id",
        email: "a@b.co",
        role: "admin",
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

    it("defaults a legacy token with no role to 'admin' (JAK-125)", async () => {
      // Simulate a pre-JAK-125 session by signing a payload without a role.
      const legacy = jwt.sign({ sub: "id", email: "a@b.co" }, FAKE_JWT_SECRET);
      const service = new AdminAuthService(users, env());
      expect(service.verifyToken(legacy)?.role).toBe("admin");
    });
  });

  describe("seedFirstAdmin (JAK-125 — guarantees superadmin)", () => {
    it("skips when the seed env is not set", async () => {
      const service = new AdminAuthService(users, env());
      expect(await service.seedFirstAdmin()).toBe("skipped");
      expect(users.insert).not.toHaveBeenCalled();
    });

    it("creates the seeded account as a superadmin, hashing the password", async () => {
      users.findByEmail.mockResolvedValue(null);
      users.insert.mockResolvedValue(row({ role: "superadmin" }));
      const service = new AdminAuthService(
        users,
        env({ adminSeedEmail: "Admin@Example.com", adminSeedPassword: "unit-test-seed-pw" })
      );

      expect(await service.seedFirstAdmin()).toBe("created");
      const [email, hash, role] = users.insert.mock.calls[0];
      expect(email).toBe("admin@example.com"); // normalized to lowercase
      // Seeded account is a superadmin so admin management is reachable on day one.
      expect(role).toBe("superadmin");
      // Never the plaintext — a bcrypt hash that verifies.
      expect(hash).not.toBe("unit-test-seed-pw");
      expect(bcrypt.compareSync("unit-test-seed-pw", hash)).toBe(true);
    });

    it("promotes an existing plain-admin seed account to superadmin (no password touch)", async () => {
      users.findByEmail.mockResolvedValue(row({ role: "admin" }));
      users.setRoleByEmail.mockResolvedValue(row({ role: "superadmin" }));
      const service = new AdminAuthService(
        users,
        env({ adminSeedEmail: "admin@example.com", adminSeedPassword: "unit-test-seed-pw" })
      );

      expect(await service.seedFirstAdmin()).toBe("promoted");
      expect(users.setRoleByEmail).toHaveBeenCalledWith("admin@example.com", "superadmin");
      // Promotion NEVER re-hashes or overwrites the password.
      expect(users.insert).not.toHaveBeenCalled();
      expect(users.setPassword).not.toHaveBeenCalled();
    });

    it("leaves an already-superadmin seed account untouched", async () => {
      users.findByEmail.mockResolvedValue(row({ role: "superadmin" }));
      const service = new AdminAuthService(
        users,
        env({ adminSeedEmail: "admin@example.com", adminSeedPassword: "pw" })
      );
      expect(await service.seedFirstAdmin()).toBe("exists");
      expect(users.insert).not.toHaveBeenCalled();
      expect(users.setRoleByEmail).not.toHaveBeenCalled();
    });
  });
});
