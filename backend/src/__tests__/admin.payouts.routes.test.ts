import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createAdminPayoutsRouter } from "../routes/admin.payouts.routes";
import { AuthService } from "../services/auth.service";

jest.mock("../services/auth.service", () => {
  const actual = jest.requireActual("../services/auth.service");
  return {
    ...actual,
    AuthService: {
      validateToken: jest.fn(async (token: string) => {
        const jsonwebtoken = require("jsonwebtoken");
        return jsonwebtoken.decode(token);
      }),
      isTokenRevoked: jest.fn().mockResolvedValue(false),
    },
  };
});

jest.mock("../services/payoutIntent.service", () => ({
  payoutIntentService: {
    reconcile: jest.fn(),
    findUnresolved: jest.fn(),
    findByKey: jest.fn(),
  },
}));

jest.mock("../services/stellar.service", () => ({
  StellarService: jest.fn().mockImplementation(() => ({
    getTransactionStatus: jest.fn(),
  })),
}));

const payoutIntents = {
  reconcile: jest.fn(),
  findUnresolved: jest.fn(),
  findByKey: jest.fn(),
};
const stellar = { getTransactionStatus: jest.fn() };

const app = express();
app.use(express.json());
app.use("/", createAdminPayoutsRouter(payoutIntents, stellar));

describe("Admin payout routes", () => {
  const adminAddress = StellarSdk.Keypair.random().publicKey();
  const nonAdminAddress = StellarSdk.Keypair.random().publicKey();
  let adminToken: string;
  let nonAdminToken: string;

  beforeAll(() => {
    process.env.ADMIN_STELLAR_PUBKEYS = adminAddress;
    const secret = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long";
    const now = Math.floor(Date.now() / 1000);
    adminToken = jwt.sign(
      { walletAddress: adminAddress, jti: "payout-admin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
    nonAdminToken = jwt.sign(
      { walletAddress: nonAdminAddress, jti: "payout-nonadmin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
  });

  describe("POST /api/admin/payouts/reconcile", () => {
    it("reconciles payout intents for an admin", async () => {
      payoutIntents.reconcile.mockResolvedValue({ processed: 2, confirmed: 1 });

      const res = await request(app)
        .post("/api/admin/payouts/reconcile")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ olderThanMs: 120_000, limit: 25 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ processed: 2, confirmed: 1 });
      expect(payoutIntents.reconcile).toHaveBeenCalledWith(expect.any(Function), {
        olderThanMs: 120_000,
        limit: 25,
      });
    });

    it("rejects an invalid reconciliation limit", async () => {
      const res = await request(app)
        .post("/api/admin/payouts/reconcile")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ limit: 0 });

      expect(res.status).toBe(400);
      expect(payoutIntents.reconcile).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/payouts/reconcile").send({});
      expect(res.status).toBe(401);
    });

    it("rejects non-admin requests", async () => {
      const res = await request(app)
        .post("/api/admin/payouts/reconcile")
        .set("Authorization", `Bearer ${nonAdminToken}`)
        .send({});
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/payouts/pending", () => {
    it("returns unresolved payout intents", async () => {
      payoutIntents.findUnresolved.mockResolvedValue([{ id: "intent-1", status: "PENDING" }]);

      const res = await request(app)
        .get("/api/admin/payouts/pending")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ intents: [{ id: "intent-1", status: "PENDING" }] });
      expect(payoutIntents.findUnresolved).toHaveBeenCalledWith(0, 100);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/admin/payouts/pending");
      expect(res.status).toBe(401);
    });
  });
});
