import crypto from "crypto";
import { TradeStatus } from "@prisma/client";
import {
  AuditTrailService,
  AuditTrailAccessDeniedError,
  AuditTrailTradeNotFoundError,
  AuditSigningConfigError,
  TradeEvent,
  CanonicalAuditPayload,
} from "../repositories/persistance";

describe("Persistence helper unit tests (AuditTrailService)", () => {
  const BUYER = "GBUYER00000000000000000000000000000000000000000000000000";
  const SELLER = "GSELLER000000000000000000000000000000000000000000000000";
  const STRANGER = "GSTRANGER0000000000000000000000000000000000000000000000";
  const TRADE_ID = "trade-persist-100";

  let keyPair: { publicKey: string; privateKey: string };
  let mockPrisma: {
    trade: { findUnique: jest.Mock };
    tradeEvidence: { findMany: jest.Mock };
    deliveryManifest: { findUnique: jest.Mock };
    dispute: { findUnique: jest.Mock };
  };
  let service: AuditTrailService;

  beforeAll(() => {
    keyPair = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  });

  beforeEach(() => {
    mockPrisma = {
      trade: { findUnique: jest.fn() },
      tradeEvidence: { findMany: jest.fn().mockResolvedValue([]) },
      deliveryManifest: { findUnique: jest.fn().mockResolvedValue(null) },
      dispute: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    service = new AuditTrailService(mockPrisma as never);
    delete process.env.AUDIT_SIGNING_KEY_ID;
    delete process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM;
    delete process.env.AUDIT_SIGNING_PUBLIC_KEY_PEM;
  });

  describe("Error classes", () => {
    it("AuditTrailAccessDeniedError has status 403 and proper name", () => {
      const err = new AuditTrailAccessDeniedError();
      expect(err.status).toBe(403);
      expect(err.name).toBe("AuditTrailAccessDeniedError");
      expect(err.message).toBe("Access denied: you are not a party to this trade");
    });

    it("AuditTrailTradeNotFoundError has status 404 and proper name", () => {
      const err = new AuditTrailTradeNotFoundError();
      expect(err.status).toBe(404);
      expect(err.name).toBe("AuditTrailTradeNotFoundError");
      expect(err.message).toBe("Trade not found");
    });

    it("AuditSigningConfigError has status 500 and configurable message", () => {
      const defaultErr = new AuditSigningConfigError();
      expect(defaultErr.status).toBe(500);
      expect(defaultErr.name).toBe("AuditSigningConfigError");
      expect(defaultErr.message).toBe("Audit signing configuration is invalid");

      const customErr = new AuditSigningConfigError("Custom config error");
      expect(customErr.status).toBe(500);
      expect(customErr.message).toBe("Custom config error");
    });
  });

  describe("getTradeHistory", () => {
    const t0 = new Date("2026-03-01T10:00:00Z");
    const t1 = new Date("2026-03-01T11:00:00Z");
    const t2 = new Date("2026-03-01T12:00:00Z");
    const t3 = new Date("2026-03-01T13:00:00Z");
    const t4 = new Date("2026-03-01T14:00:00Z");

    const baseTrade = {
      tradeId: TRADE_ID,
      buyerAddress: BUYER,
      sellerAddress: SELLER,
      amountUsdc: "150.00",
      status: TradeStatus.CREATED,
      createdAt: t0,
      updatedAt: t0,
    };

    it("throws AuditTrailTradeNotFoundError if trade is not in DB", async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(null);

      await expect(
        service.getTradeHistory(TRADE_ID, BUYER),
      ).rejects.toThrow(AuditTrailTradeNotFoundError);
    });

    it("throws AuditTrailAccessDeniedError if caller is not buyer or seller", async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(baseTrade);

      await expect(
        service.getTradeHistory(TRADE_ID, STRANGER),
      ).rejects.toThrow(AuditTrailAccessDeniedError);
    });

    it("allows caller with matching address irrespective of case", async () => {
      mockPrisma.trade.findUnique.mockResolvedValue(baseTrade);

      const events = await service.getTradeHistory(TRADE_ID, BUYER.toLowerCase());
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("CREATED");
    });

    it("builds a full chronological audit trail with all event types", async () => {
      mockPrisma.trade.findUnique.mockResolvedValue({
        ...baseTrade,
        status: TradeStatus.COMPLETED,
        updatedAt: t4,
      });

      mockPrisma.deliveryManifest.findUnique.mockResolvedValue({
        tradeId: TRADE_ID,
        vehicleRegistration: "KJA-890CD",
        expectedDeliveryAt: t2,
        createdAt: t1,
      });

      mockPrisma.tradeEvidence.findMany.mockResolvedValue([
        {
          tradeId: TRADE_ID,
          uploadedBy: SELLER,
          cid: "bafy-pdf-cid",
          filename: "receipt.pdf",
          mimeType: "application/pdf",
          createdAt: t2,
        },
        {
          tradeId: TRADE_ID,
          uploadedBy: SELLER,
          cid: "bafy-video-cid",
          filename: "inspection.mp4",
          mimeType: "video/mp4",
          createdAt: t3,
        },
      ]);

      mockPrisma.dispute.findUnique.mockResolvedValue({
        tradeId: TRADE_ID,
        initiator: BUYER,
        reason: "Delay in delivery",
        status: "RESOLVED",
        createdAt: t3,
        resolvedAt: t4,
      });

      const events = await service.getTradeHistory(TRADE_ID, SELLER);

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("CREATED");
      expect(eventTypes).toContain("FUNDED");
      expect(eventTypes).toContain("MANIFEST_SUBMITTED");
      expect(eventTypes).toContain("EVIDENCE_SUBMITTED");
      expect(eventTypes).toContain("VIDEO_SUBMITTED");
      expect(eventTypes).toContain("DELIVERY_CONFIRMED");
      expect(eventTypes).toContain("DISPUTE_INITIATED");
      expect(eventTypes).toContain("RESOLVED");
      expect(eventTypes).toContain("COMPLETED");

      // Verify chronological sorting
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timestamp.getTime()).toBeGreaterThanOrEqual(
          events[i - 1].timestamp.getTime(),
        );
      }
    });
  });

  describe("getCanonicalPayload", () => {
    it("transforms trade history into a canonical serializable payload", () => {
      const now = new Date("2026-03-01T12:00:00.000Z");
      const events: TradeEvent[] = [
        {
          eventType: "CREATED",
          timestamp: now,
          actor: BUYER,
          metadata: { amount: "100" },
        },
      ];

      const payload = service.getCanonicalPayload(TRADE_ID, events);

      expect(payload.tradeId).toBe(TRADE_ID);
      expect(new Date(payload.generatedAt).toISOString()).toBe(payload.generatedAt);
      expect(payload.events).toEqual([
        {
          eventType: "CREATED",
          timestamp: now.toISOString(),
          actor: BUYER,
          metadata: { amount: "100" },
        },
      ]);
    });
  });

  describe("signPayload and verifyPayload", () => {
    const canonicalPayload: CanonicalAuditPayload = {
      tradeId: TRADE_ID,
      generatedAt: "2026-03-01T12:00:00.000Z",
      events: [
        {
          eventType: "CREATED",
          timestamp: "2026-03-01T10:00:00.000Z",
          actor: BUYER,
          metadata: { amount: "100" },
        },
      ],
    };

    it("throws AuditSigningConfigError if signing environment variables are missing", () => {
      expect(() => service.signPayload(canonicalPayload)).toThrow(
        AuditSigningConfigError,
      );

      process.env.AUDIT_SIGNING_KEY_ID = "key-1";
      expect(() => service.signPayload(canonicalPayload)).toThrow(
        AuditSigningConfigError,
      );
    });

    it("signs a canonical payload with ed25519 and sha256 hash", () => {
      process.env.AUDIT_SIGNING_KEY_ID = "test-key-id";
      process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM = keyPair.privateKey;

      const integrity = service.signPayload(canonicalPayload);

      expect(integrity.algorithm).toBe("ed25519");
      expect(integrity.keyId).toBe("test-key-id");
      expect(integrity.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(integrity.signature).toBeTruthy();
    });

    it("throws AuditSigningConfigError if public key PEM is missing for verification", () => {
      expect(() => service.verifyPayload(canonicalPayload, "sig")).toThrow(
        AuditSigningConfigError,
      );
    });

    it("verifies a valid payload signature successfully", () => {
      process.env.AUDIT_SIGNING_KEY_ID = "test-key-id";
      process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM = keyPair.privateKey;
      process.env.AUDIT_SIGNING_PUBLIC_KEY_PEM = keyPair.publicKey;

      const integrity = service.signPayload(canonicalPayload);
      const isValid = service.verifyPayload(canonicalPayload, integrity.signature);

      expect(isValid).toBe(true);
    });

    it("rejects an altered payload or invalid signature", () => {
      process.env.AUDIT_SIGNING_KEY_ID = "test-key-id";
      process.env.AUDIT_SIGNING_PRIVATE_KEY_PEM = keyPair.privateKey;
      process.env.AUDIT_SIGNING_PUBLIC_KEY_PEM = keyPair.publicKey;

      const integrity = service.signPayload(canonicalPayload);

      const tamperedPayload: CanonicalAuditPayload = {
        ...canonicalPayload,
        tradeId: "tampered-trade-id",
      };

      const isValid = service.verifyPayload(tamperedPayload, integrity.signature);
      expect(isValid).toBe(false);
    });
  });
});
