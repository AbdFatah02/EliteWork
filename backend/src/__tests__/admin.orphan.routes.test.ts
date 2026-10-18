import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createAdminOrphanRouter } from "../routes/admin.orphan.routes";
import { AuthService } from "../services/auth.service";
import { orphanDepositService } from "../services/orphanDeposit.service";

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

jest.mock("../services/orphanDeposit.service", () => ({
  orphanDepositService: {
    listOrphans: jest.fn(),
    ingestDepositEvents: jest.fn(),
    attachOrphanToTrade: jest.fn(),
  },
}));

const mockOrphanService = orphanDepositService as unknown as {
  listOrphans: jest.Mock;
  ingestDepositEvents: jest.Mock;
  attachOrphanToTrade: jest.Mock;
};

const app = express();
app.use(express.json());
app.use("/", createAdminOrphanRouter());

describe("Admin orphan deposit routes", () => {
  const adminAddress = StellarSdk.Keypair.random().publicKey();
  const nonAdminAddress = StellarSdk.Keypair.random().publicKey();
  let adminToken: string;
  let nonAdminToken: string;

  beforeAll(() => {
    process.env.ADMIN_STELLAR_PUBKEYS = adminAddress;
    const secret = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long";
    const now = Math.floor(Date.now() / 1000);
    adminToken = jwt.sign(
      { walletAddress: adminAddress, jti: "orphan-admin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
    nonAdminToken = jwt.sign(
      { walletAddress: nonAdminAddress, jti: "orphan-nonadmin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
  });

  describe("GET /api/admin/orphan-deposits", () => {
    it("returns a page of orphan deposits", async () => {
      mockOrphanService.listOrphans.mockResolvedValue({ items: [{ id: 7 }], total: 1 });

      const res = await request(app)
        .get("/api/admin/orphan-deposits?page=2&limit=10")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [{ id: 7 }], total: 1 });
      expect(mockOrphanService.listOrphans).toHaveBeenCalledWith(2, 10);
    });

    it("rejects an invalid page query", async () => {
      const res = await request(app)
        .get("/api/admin/orphan-deposits?page=0")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(mockOrphanService.listOrphans).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/admin/orphan-deposits");
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/admin/orphan-deposits/ingest", () => {
    const events = [
      {
        ledgerSeq: 100,
        txHash: "tx-hash",
        depositorAddress: "GDEPOSITOR",
        amountRaw: "1250000",
        assetId: "USDC",
        contractTradeId: "trade-1",
      },
    ];

    it("ingests deposit events", async () => {
      mockOrphanService.ingestDepositEvents.mockResolvedValue({ ingested: 1 });

      const res = await request(app)
        .post("/api/admin/orphan-deposits/ingest")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ events });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ingested: 1 });
      expect(mockOrphanService.ingestDepositEvents).toHaveBeenCalledWith(events);
    });

    it("rejects an empty event list", async () => {
      const res = await request(app)
        .post("/api/admin/orphan-deposits/ingest")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ events: [] });

      expect(res.status).toBe(400);
      expect(mockOrphanService.ingestDepositEvents).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/orphan-deposits/ingest").send({ events });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/admin/orphan-deposits/:id/attach", () => {
    it("attaches an orphan deposit to a trade", async () => {
      mockOrphanService.attachOrphanToTrade.mockResolvedValue(undefined);

      const res = await request(app)
        .post("/api/admin/orphan-deposits/17/attach")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tradeId: "trade-2" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, orphanId: 17, tradeId: "trade-2" });
      expect(mockOrphanService.attachOrphanToTrade).toHaveBeenCalledWith(
        17,
        "trade-2",
        adminAddress,
      );
    });

    it("rejects an invalid orphan id", async () => {
      const res = await request(app)
        .post("/api/admin/orphan-deposits/not-a-number/attach")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tradeId: "trade-2" });

      expect(res.status).toBe(400);
      expect(mockOrphanService.attachOrphanToTrade).not.toHaveBeenCalled();
    });

    it("rejects an empty trade id", async () => {
      const res = await request(app)
        .post("/api/admin/orphan-deposits/17/attach")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ tradeId: "" });

      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app)
        .post("/api/admin/orphan-deposits/17/attach")
        .send({ tradeId: "trade-2" });
      expect(res.status).toBe(401);
    });

    it("rejects non-admin requests", async () => {
      const res = await request(app)
        .post("/api/admin/orphan-deposits/17/attach")
        .set("Authorization", `Bearer ${nonAdminToken}`)
        .send({ tradeId: "trade-2" });
      expect(res.status).toBe(403);
    });
  });
});
