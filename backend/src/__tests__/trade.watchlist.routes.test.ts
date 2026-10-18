import express, { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createTradeWatchlistRouter } from "../routes/trade.watchlist.routes";
import {
  TradeWatchlistService,
  WatchTradeNotFoundError,
  WatchTradeAccessDeniedError,
} from "../services/trade.watchlist.service";
import { errorHandler } from "../middleware/errorHandler";
import { AuthService } from "../services/auth.service";

jest.mock("../services/auth.service", () => ({
  AuthService: {
    validateToken: jest.fn(async (token: string) => {
      const jsonwebtoken = require("jsonwebtoken");
      return jsonwebtoken.decode(token);
    }),
    isTokenRevoked: jest.fn().mockResolvedValue(false),
  },
}));

describe("Trade Watchlist Routes", () => {
  const userAddress = "GBUYER00000000000000000000000000000000000000000000000000";
  const tradeId = "trade-watch-123";

  let app: Express;
  let validToken: string;
  let emptyWalletToken: string;

  let mockAdd: jest.SpyInstance;
  let mockRemove: jest.SpyInstance;
  let mockList: jest.SpyInstance;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
    process.env.JWT_ISSUER = process.env.JWT_ISSUER || "amana";
    process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "amana-api";

    validToken = jwt.sign(
      {
        walletAddress: userAddress,
        jti: "watchlist-test-jti-1",
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
      },
      process.env.JWT_SECRET,
    );

    emptyWalletToken = jwt.sign(
      {
        walletAddress: "   ",
        jti: "watchlist-test-jti-2",
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
      },
      process.env.JWT_SECRET,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockAdd = jest.spyOn(TradeWatchlistService.prototype, "add");
    mockRemove = jest.spyOn(TradeWatchlistService.prototype, "remove");
    mockList = jest.spyOn(TradeWatchlistService.prototype, "list");

    app = express();
    app.use(express.json());
    app.use("/trades", createTradeWatchlistRouter());
    app.use(errorHandler);
  });

  afterEach(() => {
    mockAdd.mockRestore();
    mockRemove.mockRestore();
    mockList.mockRestore();
  });

  describe("POST /trades/:id/watch", () => {
    it("happy path: adds trade to watchlist and returns 201", async () => {
      const mockWatchRecord = {
        id: 1,
        userAddress: userAddress.toLowerCase(),
        tradeId,
        createdAt: new Date("2026-03-01T12:00:00Z"),
      };
      mockAdd.mockResolvedValue(mockWatchRecord);

      const res = await request(app)
        .post(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        watch: {
          ...mockWatchRecord,
          createdAt: mockWatchRecord.createdAt.toISOString(),
        },
      });
      expect(mockAdd).toHaveBeenCalledWith(tradeId, userAddress);
    });

    it("validation failure: returns 400 when trade id is whitespace only", async () => {
      const res = await request(app)
        .post("/trades/%20/watch")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app).post(`/trades/${tradeId}/watch`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when user token has missing/empty wallet address", async () => {
      const res = await request(app)
        .post(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${emptyWalletToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("error mapping: returns 404 when trade does not exist (WatchTradeNotFoundError)", async () => {
      mockAdd.mockRejectedValue(new WatchTradeNotFoundError());

      const res = await request(app)
        .post(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Trade not found" });
    });

    it("error mapping: returns 403 when caller is not party to trade (WatchTradeAccessDeniedError)", async () => {
      mockAdd.mockRejectedValue(new WatchTradeAccessDeniedError());

      const res = await request(app)
        .post(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Forbidden",
      });
    });

    it("error mapping: returns 500 when unexpected error is thrown", async () => {
      mockAdd.mockRejectedValue(new Error("Unexpected DB crash"));

      const res = await request(app)
        .post(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Unexpected DB crash");
    });
  });

  describe("DELETE /trades/:id/watch", () => {
    it("happy path: removes trade from watchlist and returns 200", async () => {
      mockRemove.mockResolvedValue({ removed: true });

      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ removed: true });
      expect(mockRemove).toHaveBeenCalledWith(tradeId, userAddress);
    });

    it("happy path: returns 200 when watch was already not present", async () => {
      mockRemove.mockResolvedValue({ removed: false });

      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ removed: false });
    });

    it("validation failure: returns 400 when trade id is whitespace only", async () => {
      const res = await request(app)
        .delete("/trades/%20/watch")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app).delete(`/trades/${tradeId}/watch`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when user token has missing/empty wallet address", async () => {
      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${emptyWalletToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it("error mapping: returns 404 when trade does not exist (WatchTradeNotFoundError)", async () => {
      mockRemove.mockRejectedValue(new WatchTradeNotFoundError());

      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Trade not found" });
    });

    it("error mapping: returns 403 when caller is not party (WatchTradeAccessDeniedError)", async () => {
      mockRemove.mockRejectedValue(new WatchTradeAccessDeniedError());

      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: "Forbidden",
      });
    });

    it("error mapping: returns 500 when unexpected error occurs", async () => {
      mockRemove.mockRejectedValue(new Error("Unexpected error"));

      const res = await request(app)
        .delete(`/trades/${tradeId}/watch`)
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Unexpected error");
    });
  });

  describe("GET /trades/watched", () => {
    it("happy path: returns caller watched items with status 200", async () => {
      const watchedItems = [
        {
          id: 5,
          tradeId: "trade-001",
          buyerAddress: userAddress,
          sellerAddress: "GSELLER",
          amountUsdc: "100.00",
          watchedAt: new Date("2026-03-01T10:00:00Z"),
        },
      ];
      mockList.mockResolvedValue(watchedItems);

      const res = await request(app)
        .get("/trades/watched")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [
          {
            ...watchedItems[0],
            watchedAt: watchedItems[0].watchedAt.toISOString(),
          },
        ],
      });
      expect(mockList).toHaveBeenCalledWith(userAddress);
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app).get("/trades/watched");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockList).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when user token has missing/empty wallet address", async () => {
      const res = await request(app)
        .get("/trades/watched")
        .set("Authorization", `Bearer ${emptyWalletToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockList).not.toHaveBeenCalled();
    });

    it("error mapping: forwards unhandled exceptions to errorHandler (500)", async () => {
      mockList.mockRejectedValue(new Error("Database connection lost"));

      const res = await request(app)
        .get("/trades/watched")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Database connection lost");
    });
  });
});
