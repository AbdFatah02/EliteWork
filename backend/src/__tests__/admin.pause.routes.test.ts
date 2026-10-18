import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createAdminPauseRouter } from "../routes/admin.pause.routes";
import { AuthService } from "../services/auth.service";
import { prisma } from "../lib/db";

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

jest.mock("../lib/db", () => ({
  prisma: {
    contractPauseLog: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

const mockPrisma = prisma as unknown as {
  contractPauseLog: {
    create: jest.Mock;
    findFirst: jest.Mock;
  };
};

const app = express();
app.use(express.json());
app.use("/", createAdminPauseRouter());

describe("Admin pause routes", () => {
  const adminAddress = StellarSdk.Keypair.random().publicKey();
  const nonAdminAddress = StellarSdk.Keypair.random().publicKey();
  let adminToken: string;
  let nonAdminToken: string;
  const body = {
    guardianAddress: "GTESTGUARDIAN",
    reason: "Scheduled maintenance",
    txHash: "pause-tx-hash",
  };

  beforeAll(() => {
    process.env.ADMIN_STELLAR_PUBKEYS = adminAddress;
    const secret = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long";
    const now = Math.floor(Date.now() / 1000);
    adminToken = jwt.sign(
      { walletAddress: adminAddress, jti: "pause-admin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
    nonAdminToken = jwt.sign(
      { walletAddress: nonAdminAddress, jti: "pause-nonadmin-jti", nbf: now - 1 },
      secret,
      { algorithm: "HS256" },
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(AuthService, "isTokenRevoked").mockResolvedValue(false);
  });

  describe("POST /api/admin/contract/pause", () => {
    it("records the pause event", async () => {
      mockPrisma.contractPauseLog.create.mockResolvedValue({});

      const res = await request(app)
        .post("/api/admin/contract/pause")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        paused: true,
        guardianAddress: body.guardianAddress,
        reason: body.reason,
      });
      expect(mockPrisma.contractPauseLog.create).toHaveBeenCalledWith({
        data: { paused: true, ...body },
      });
    });

    it("rejects a missing guardian address", async () => {
      const res = await request(app)
        .post("/api/admin/contract/pause")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Scheduled maintenance" });

      expect(res.status).toBe(400);
      expect(mockPrisma.contractPauseLog.create).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/contract/pause").send(body);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/admin/contract/unpause", () => {
    it("records the unpause event", async () => {
      mockPrisma.contractPauseLog.create.mockResolvedValue({});

      const res = await request(app)
        .post("/api/admin/contract/unpause")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        paused: false,
        guardianAddress: body.guardianAddress,
        reason: body.reason,
      });
      expect(mockPrisma.contractPauseLog.create).toHaveBeenCalledWith({
        data: { paused: false, ...body },
      });
    });

    it("rejects an empty guardian address", async () => {
      const res = await request(app)
        .post("/api/admin/contract/unpause")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ ...body, guardianAddress: "" });

      expect(res.status).toBe(400);
      expect(mockPrisma.contractPauseLog.create).not.toHaveBeenCalled();
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).post("/api/admin/contract/unpause").send(body);
      expect(res.status).toBe(401);
    });

    it("rejects non-admin requests", async () => {
      const res = await request(app)
        .post("/api/admin/contract/unpause")
        .set("Authorization", `Bearer ${nonAdminToken}`)
        .send(body);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/admin/contract/pause-status", () => {
    it("returns the latest pause status", async () => {
      const latest = {
        paused: true,
        guardianAddress: body.guardianAddress,
        reason: body.reason,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      mockPrisma.contractPauseLog.findFirst.mockResolvedValue(latest);

      const res = await request(app)
        .get("/api/admin/contract/pause-status")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        paused: true,
        lastEvent: { ...latest, createdAt: latest.createdAt.toISOString() },
      });
      expect(mockPrisma.contractPauseLog.findFirst).toHaveBeenCalledWith({
        orderBy: { createdAt: "desc" },
        select: { paused: true, guardianAddress: true, reason: true, createdAt: true },
      });
    });

    it("defaults to unpaused when no event exists", async () => {
      mockPrisma.contractPauseLog.findFirst.mockResolvedValue(null);

      const res = await request(app)
        .get("/api/admin/contract/pause-status")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ paused: false, lastEvent: null });
    });

    it("rejects unauthenticated requests", async () => {
      const res = await request(app).get("/api/admin/contract/pause-status");
      expect(res.status).toBe(401);
    });
  });
});
