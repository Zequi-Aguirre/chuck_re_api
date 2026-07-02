import express, { Express } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { mock, MockProxy } from "jest-mock-extended";
import { EnvConfig } from "../../../config/envConfig";
import { AdminAuthService } from "../AdminAuthService";
import { AdminAuthResource } from "../AdminAuthResource";
import { ADMIN_COOKIE } from "../requireAdminAuth";

const ADMIN = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  email: "admin@example.com",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("AdminAuthResource", () => {
  let auth: MockProxy<AdminAuthService>;
  let app: Express;

  beforeEach(() => {
    auth = mock<AdminAuthService>();
    const env = { isProduction: false } as EnvConfig;
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use("/api/admin/auth", new AdminAuthResource(auth, env).router);
  });

  describe("POST /login", () => {
    it("sets an httpOnly session cookie on success", async () => {
      auth.verifyCredentials.mockResolvedValue(ADMIN);
      auth.issueToken.mockReturnValue("unit-test-token");
      (auth as unknown as { sessionTtlSeconds: number }).sessionTtlSeconds = 3600;

      const res = await request(app)
        .post("/api/admin/auth/login")
        .send({ email: "admin@example.com", password: "correct" });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("admin@example.com");
      const cookie = res.headers["set-cookie"][0];
      expect(cookie).toContain(`${ADMIN_COOKIE}=unit-test-token`);
      expect(cookie).toContain("HttpOnly");
      // The raw token is never echoed in the body.
      expect(JSON.stringify(res.body)).not.toContain("unit-test-token");
    });

    it("returns a generic 401 on bad credentials (no cookie, no enumeration)", async () => {
      auth.verifyCredentials.mockResolvedValue(null);
      const res = await request(app)
        .post("/api/admin/auth/login")
        .send({ email: "admin@example.com", password: "wrong" });
      expect(res.status).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(auth.issueToken).not.toHaveBeenCalled();
    });

    it("400s when a field is missing", async () => {
      const res = await request(app).post("/api/admin/auth/login").send({ email: "a@b.co" });
      expect(res.status).toBe(400);
      expect(auth.verifyCredentials).not.toHaveBeenCalled();
    });
  });

  describe("GET /me", () => {
    it("401s without a valid session", async () => {
      auth.verifyToken.mockReturnValue(null);
      const res = await request(app).get("/api/admin/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns the admin identity with a valid bearer token", async () => {
      auth.verifyToken.mockReturnValue({ sub: ADMIN.id, email: ADMIN.email });
      const res = await request(app)
        .get("/api/admin/auth/me")
        .set("Authorization", "Bearer good.token");
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe("admin@example.com");
    });
  });
});
