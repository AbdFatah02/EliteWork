import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createAdminExpiryRouter } from "../routes/admin.expiry.routes";
import { AuthService } from "../services/auth.service";
import { tradeExpiryService } from "../services/tradeExpiry.service";
import { tradeExpiryQueue } from "../jobs/queue";

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

jest.mock("../services/tradeExpiry.service", () => ({
  tradeExpiryService: {
    sweepExpiredTrades: jest.fn(),
    getPendingRefunds: jest.fn(),
  },
}));

jest.mock("../jobs/queue", () => ({
  tradeExpiryQueue: { add: jest.fn() },
}));

const mockExpiryService = tradeExpiryService as unknown as {
  sweepExpiredTrades: jest.Mock;
  getPendingRefunds: jest.Mock;
};
const mockExpiryQueue = tradeExpiryQueue as unknown as { add: jest.Mock };

const app = express();
app.use(express.json());
app.use("/", createAdminExpiryRouter());

describe("Admin expiry routes", () => {
  const adminAddress = StellarSdk.Keypair.random().publicKey();
  const nonAdminAddress = StellarSdk.Keypair.random().publicKey();
  let adminToken: string;
  let nonAdminToken: string;

  beforeAll(() => {
    process.env.ADMIN_STELLAR_PUBKEYS = adminAddress;
    const secret = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long";
    const now = Math.floor(Date.now() / 1000);
    adminToken = jwt.sign(
      { walletAddress: adminAddress, jti: "expiry-admin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
    nonAdminToken = jwt.sign(
      { walletAddress: nonAdminAddress, jti: "expiry-nonadmin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
  });

  describe("POST /api/admin/trades/sweep-expired", () => {
    it("sweeps expired trades for an admin", async () => {
      mockExpiryService.sweepExpiredTrades.mockResolvedValue({ processed: 3 });

      const res = await request(app)
        .post("/api/admin/trades/sweep-expired")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ batchSize: 25 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ processed: 3 });
      expect(mockExpiryService.sweepExpiredTrades).toHaveBeenCalledWith(25);
    });

    it("rejects an invalid batch size", async () => {
      const res = await request(app)
        .post("/api/admin/trades/sweep-expired")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ batchSize: 501 });

      expect(res.status).toBe(400);
      expect(mockExpiryService.sweepExpiredTrades).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/trades/sweep-expired").send({});
      expect(res.status).toBe(401);
    });

    it("rejects non-admin requests", async () => {
      const res = await request(app)
        .post("/api/admin/trades/sweep-expired")
        .set("Authorization", `Bearer ${nonAdminToken}`)
        .send({ batchSize: 25 });
      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/admin/trades/sweep-expired/enqueue", () => {
    it("enqueues an expiry sweep for an admin", async () => {
      mockExpiryQueue.add.mockResolvedValue({ id: "expiry-job-1" });

      const res = await request(app)
        .post("/api/admin/trades/sweep-expired/enqueue")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ batchSize: 40 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jobId: "expiry-job-1", batchSize: 40 });
      expect(mockExpiryQueue.add).toHaveBeenCalledWith("admin-sweep", { batchSize: 40 });
    });

    it("rejects an invalid batch size", async () => {
      const res = await request(app)
        .post("/api/admin/trades/sweep-expired/enqueue")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ batchSize: 0 });

      expect(res.status).toBe(400);
      expect(mockExpiryQueue.add).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/trades/sweep-expired/enqueue").send({});
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/admin/trades/pending-refunds", () => {
    it("returns pending refunds for an admin", async () => {
      mockExpiryService.getPendingRefunds.mockResolvedValue([{ id: 12, status: "EXPIRED" }]);

      const res = await request(app)
        .get("/api/admin/trades/pending-refunds")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 1, trades: [{ id: 12, status: "EXPIRED" }] });
      expect(mockExpiryService.getPendingRefunds).toHaveBeenCalledTimes(1);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/admin/trades/pending-refunds");
      expect(res.status).toBe(401);
    });
  });
});
