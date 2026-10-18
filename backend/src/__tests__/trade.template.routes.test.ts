import express, { Express } from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { createTradeTemplateRouter } from "../routes/trade.template.routes";
import {
  TradeTemplateService,
  TradeTemplateNotFoundError,
} from "../services/trade.template.service";
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

describe("Trade Template Routes", () => {
  const userAddress = StellarSdk.Keypair.random().publicKey();
  const validSellerAddress = StellarSdk.Keypair.random().publicKey();

  let app: Express;
  let validToken: string;
  let emptyWalletToken: string;

  let mockSave: jest.SpyInstance;
  let mockList: jest.SpyInstance;
  let mockCreateTradeFromTemplate: jest.SpyInstance;

  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-at-least-32-characters-long!";
    process.env.JWT_ISSUER = process.env.JWT_ISSUER || "amana";
    process.env.JWT_AUDIENCE = process.env.JWT_AUDIENCE || "amana-api";

    validToken = jwt.sign(
      {
        walletAddress: userAddress,
        jti: "template-test-jti-1",
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
      },
      process.env.JWT_SECRET,
    );

    emptyWalletToken = jwt.sign(
      {
        walletAddress: "   ",
        jti: "template-test-jti-2",
        iss: process.env.JWT_ISSUER,
        aud: process.env.JWT_AUDIENCE,
      },
      process.env.JWT_SECRET,
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();

    mockSave = jest.spyOn(TradeTemplateService.prototype, "save");
    mockList = jest.spyOn(TradeTemplateService.prototype, "list");
    mockCreateTradeFromTemplate = jest.spyOn(
      TradeTemplateService.prototype,
      "createTradeFromTemplate",
    );

    app = express();
    app.use(express.json());
    app.use("/trades", createTradeTemplateRouter());
    app.use(errorHandler);
  });

  afterEach(() => {
    mockSave.mockRestore();
    mockList.mockRestore();
    mockCreateTradeFromTemplate.mockRestore();
  });

  describe("POST /trades/templates", () => {
    const validBody = {
      name: "Weekly maize supply",
      sellerAddress: validSellerAddress,
      amountUsdc: "100.50",
      buyerLossBps: 5000,
      sellerLossBps: 5000,
    };

    it("happy path: saves template and returns 201", async () => {
      const savedTemplate = {
        id: 7,
        userAddress,
        ...validBody,
        createdAt: new Date("2026-03-01T10:00:00Z"),
        updatedAt: new Date("2026-03-01T10:00:00Z"),
      };
      mockSave.mockResolvedValue(savedTemplate);

      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        template: {
          ...savedTemplate,
          createdAt: savedTemplate.createdAt.toISOString(),
          updatedAt: savedTemplate.updatedAt.toISOString(),
        },
      });
      expect(mockSave).toHaveBeenCalledWith(userAddress, expect.objectContaining({
        name: validBody.name,
        sellerAddress: validSellerAddress,
        amountUsdc: expect.stringMatching(/^100\.50/),
      }));
    });

    it("validation failure: rejects request when name is empty", async () => {
      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`)
        .send({ ...validBody, name: "   " });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("validation failure: rejects request when seller address is invalid Stellar public key", async () => {
      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`)
        .send({ ...validBody, sellerAddress: "invalid-public-key" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("validation failure: rejects request when loss basis points do not sum to 10000", async () => {
      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`)
        .send({ ...validBody, buyerLossBps: 3000, sellerLossBps: 3000 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app)
        .post("/trades/templates")
        .send(validBody);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when token has empty wallet address", async () => {
      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${emptyWalletToken}`)
        .send(validBody);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockSave).not.toHaveBeenCalled();
    });

    it("error mapping: forwards unhandled service errors to errorHandler (500)", async () => {
      mockSave.mockRejectedValue(new Error("Database failure"));

      const res = await request(app)
        .post("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`)
        .send(validBody);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Database failure");
    });
  });

  describe("GET /trades/templates", () => {
    it("happy path: returns caller templates with 200", async () => {
      const templateList = [
        {
          id: 1,
          userAddress,
          name: "Template 1",
          sellerAddress: validSellerAddress,
          amountUsdc: "100.00",
          buyerLossBps: 5000,
          sellerLossBps: 5000,
          createdAt: new Date("2026-03-01T10:00:00Z"),
          updatedAt: new Date("2026-03-01T10:00:00Z"),
        },
      ];
      mockList.mockResolvedValue(templateList);

      const res = await request(app)
        .get("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        templates: [
          {
            ...templateList[0],
            createdAt: templateList[0].createdAt.toISOString(),
            updatedAt: templateList[0].updatedAt.toISOString(),
          },
        ],
      });
      expect(mockList).toHaveBeenCalledWith(userAddress);
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app).get("/trades/templates");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockList).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when token has empty wallet address", async () => {
      const res = await request(app)
        .get("/trades/templates")
        .set("Authorization", `Bearer ${emptyWalletToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockList).not.toHaveBeenCalled();
    });

    it("error mapping: forwards unhandled service errors to errorHandler (500)", async () => {
      mockList.mockRejectedValue(new Error("Failed to fetch templates"));

      const res = await request(app)
        .get("/trades/templates")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Failed to fetch templates");
    });
  });

  describe("POST /trades/from-template/:templateId", () => {
    it("happy path: creates trade from template and returns 201", async () => {
      const creationResult = {
        tradeId: "trade-generated-88",
        unsignedXdr: "AAAA-xdr-content",
        templateId: 15,
      };
      mockCreateTradeFromTemplate.mockResolvedValue(creationResult);

      const res = await request(app)
        .post("/trades/from-template/15")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(201);
      expect(res.body).toEqual(creationResult);
      expect(mockCreateTradeFromTemplate).toHaveBeenCalledWith(15, userAddress);
    });

    it("validation failure: rejects non-numeric templateId with 400", async () => {
      const res = await request(app)
        .post("/trades/from-template/abc")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockCreateTradeFromTemplate).not.toHaveBeenCalled();
    });

    it("validation failure: rejects zero or negative templateId with 400", async () => {
      const res = await request(app)
        .post("/trades/from-template/0")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      expect(mockCreateTradeFromTemplate).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when Authorization header is missing", async () => {
      const res = await request(app).post("/trades/from-template/15");

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Missing Authorization header");
      expect(mockCreateTradeFromTemplate).not.toHaveBeenCalled();
    });

    it("auth failure: returns 401 when token has empty wallet address", async () => {
      const res = await request(app)
        .post("/trades/from-template/15")
        .set("Authorization", `Bearer ${emptyWalletToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
      expect(mockCreateTradeFromTemplate).not.toHaveBeenCalled();
    });

    it("error mapping: returns 404 when template is not found (TradeTemplateNotFoundError)", async () => {
      mockCreateTradeFromTemplate.mockRejectedValue(
        new TradeTemplateNotFoundError(),
      );

      const res = await request(app)
        .post("/trades/from-template/404")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Trade template not found" });
    });

    it("error mapping: forwards unhandled service errors to errorHandler (500)", async () => {
      mockCreateTradeFromTemplate.mockRejectedValue(
        new Error("Unexpected template creation crash"),
      );

      const res = await request(app)
        .post("/trades/from-template/15")
        .set("Authorization", `Bearer ${validToken}`);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("Unexpected template creation crash");
    });
  });
});
