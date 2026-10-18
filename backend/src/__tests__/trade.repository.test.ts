import { Prisma, Trade, TradeStatus } from "@prisma/client";
import {
  TradeRepository,
  TradeNotFoundError,
  TradeConstraintViolationError,
  tradeRepository,
  TradeDatabase,
} from "../repositories/trade.repository";
import type { TradeRecord } from "../types/trade";

describe("TradeRepository", () => {
  const mockTrade: Trade = {
    id: 10,
    tradeId: "trade-test-001",
    buyerAddress: "gbuyer00000000000000000000000000000000000000000000000000",
    sellerAddress: "gseller000000000000000000000000000000000000000000000000",
    amountUsdc: "250.00",
    buyerLossBps: 5000,
    sellerLossBps: 5000,
    version: 0,
    status: TradeStatus.CREATED,
    fundedAt: null,
    deliveredAt: null,
    completedAt: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date("2026-02-01T12:00:00Z"),
    updatedAt: new Date("2026-02-01T12:00:00Z"),
  };

  const createP2002Error = (message = "Unique constraint failed") =>
    new Prisma.PrismaClientKnownRequestError(message, {
      code: "P2002",
      clientVersion: "5.22.0",
    });

  const createP2025Error = (message = "Record to update/delete not found") =>
    new Prisma.PrismaClientKnownRequestError(message, {
      code: "P2025",
      clientVersion: "5.22.0",
    });

  let mockPrisma: {
    trade: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      upsert: jest.Mock;
      delete: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let repository: TradeRepository;

  beforeEach(() => {
    mockPrisma = {
      trade: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
      },
    };
    repository = new TradeRepository(mockPrisma as unknown as TradeDatabase);
  });

  describe("query methods", () => {
    describe("findById", () => {
      it("returns the trade when found by numeric id", async () => {
        mockPrisma.trade.findUnique.mockResolvedValue(mockTrade);

        const result = await repository.findById(10);

        expect(result).toEqual(mockTrade);
        expect(mockPrisma.trade.findUnique).toHaveBeenCalledWith({
          where: { id: 10 },
        });
      });

      it("returns null when trade is not found by id", async () => {
        mockPrisma.trade.findUnique.mockResolvedValue(null);

        const result = await repository.findById(999);

        expect(result).toBeNull();
        expect(mockPrisma.trade.findUnique).toHaveBeenCalledWith({
          where: { id: 999 },
        });
      });
    });

    describe("findByTradeId", () => {
      it("returns the trade when found by string tradeId", async () => {
        mockPrisma.trade.findUnique.mockResolvedValue(mockTrade);

        const result = await repository.findByTradeId("trade-test-001");

        expect(result).toEqual(mockTrade);
        expect(mockPrisma.trade.findUnique).toHaveBeenCalledWith({
          where: { tradeId: "trade-test-001" },
        });
      });

      it("returns null when trade is not found by tradeId", async () => {
        mockPrisma.trade.findUnique.mockResolvedValue(null);

        const result = await repository.findByTradeId("non-existent-trade");

        expect(result).toBeNull();
        expect(mockPrisma.trade.findUnique).toHaveBeenCalledWith({
          where: { tradeId: "non-existent-trade" },
        });
      });
    });

    describe("list", () => {
      it("returns all trades matching filter criteria", async () => {
        mockPrisma.trade.findMany.mockResolvedValue([mockTrade]);

        const result = await repository.list({
          status: TradeStatus.CREATED,
          buyerAddress: "GBUYER00000000000000000000000000000000000000000000000000",
          sellerAddress: "GSELLER000000000000000000000000000000000000000000000000",
          skip: 0,
          take: 10,
        });

        expect(result).toEqual([mockTrade]);
        expect(mockPrisma.trade.findMany).toHaveBeenCalledWith({
          where: {
            status: TradeStatus.CREATED,
            buyerAddress: "gbuyer00000000000000000000000000000000000000000000000000",
            sellerAddress: "gseller000000000000000000000000000000000000000000000000",
          },
          skip: 0,
          take: 10,
          orderBy: { createdAt: "desc" },
        });
      });

      it("defaults filters when none are provided", async () => {
        mockPrisma.trade.findMany.mockResolvedValue([]);

        const result = await repository.list();

        expect(result).toEqual([]);
        expect(mockPrisma.trade.findMany).toHaveBeenCalledWith({
          where: {},
          skip: undefined,
          take: undefined,
          orderBy: { createdAt: "desc" },
        });
      });
    });
  });

  describe("mutation methods", () => {
    describe("create", () => {
      const createInput: Prisma.TradeUncheckedCreateInput = {
        tradeId: "trade-test-001",
        buyerAddress: mockTrade.buyerAddress,
        sellerAddress: mockTrade.sellerAddress,
        amountUsdc: "250.00",
        buyerLossBps: 5000,
        sellerLossBps: 5000,
        status: TradeStatus.CREATED,
      };

      it("creates and returns a new trade record", async () => {
        mockPrisma.trade.create.mockResolvedValue(mockTrade);

        const result = await repository.create(createInput);

        expect(result).toEqual(mockTrade);
        expect(mockPrisma.trade.create).toHaveBeenCalledWith({
          data: createInput,
        });
      });

      it("throws TradeConstraintViolationError when unique constraint fails (P2002)", async () => {
        mockPrisma.trade.create.mockRejectedValue(createP2002Error());

        await expect(repository.create(createInput)).rejects.toThrow(
          TradeConstraintViolationError,
        );
      });

      it("re-throws generic unhandled database errors", async () => {
        mockPrisma.trade.create.mockRejectedValue(new Error("Database disconnected"));

        await expect(repository.create(createInput)).rejects.toThrow(
          "Database disconnected",
        );
      });
    });

    describe("update", () => {
      const updateInput: Prisma.TradeUpdateInput = {
        status: TradeStatus.FUNDED,
        fundedAt: new Date("2026-02-01T13:00:00Z"),
      };

      it("updates and returns the updated trade record", async () => {
        const updatedTrade = { ...mockTrade, status: TradeStatus.FUNDED };
        mockPrisma.trade.update.mockResolvedValue(updatedTrade);

        const result = await repository.update("trade-test-001", updateInput);

        expect(result).toEqual(updatedTrade);
        expect(mockPrisma.trade.update).toHaveBeenCalledWith({
          where: { tradeId: "trade-test-001" },
          data: updateInput,
        });
      });

      it("throws TradeNotFoundError when record does not exist (P2025)", async () => {
        mockPrisma.trade.update.mockRejectedValue(createP2025Error());

        await expect(
          repository.update("missing-trade-id", updateInput),
        ).rejects.toThrow(TradeNotFoundError);
      });

      it("throws TradeConstraintViolationError when update triggers constraint violation (P2002)", async () => {
        mockPrisma.trade.update.mockRejectedValue(createP2002Error());

        await expect(
          repository.update("trade-test-001", updateInput),
        ).rejects.toThrow(TradeConstraintViolationError);
      });

      it("re-throws other Prisma or database errors", async () => {
        mockPrisma.trade.update.mockRejectedValue(new Error("Timeout error"));

        await expect(
          repository.update("trade-test-001", updateInput),
        ).rejects.toThrow("Timeout error");
      });
    });

    describe("upsert", () => {
      const upsertRecord: TradeRecord = {
        id: 10,
        tradeId: "trade-test-001",
        buyerAddress: mockTrade.buyerAddress,
        sellerAddress: mockTrade.sellerAddress,
        amountUsdc: "250.00",
        status: TradeStatus.CREATED,
      };

      it("upserts a trade record with Prisma", async () => {
        mockPrisma.trade.upsert.mockResolvedValue(mockTrade);

        const result = await repository.upsert(upsertRecord);

        expect(result).toEqual(mockTrade);
        expect(mockPrisma.trade.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { tradeId: "trade-test-001" },
            create: expect.objectContaining({ tradeId: "trade-test-001" }),
            update: expect.objectContaining({ tradeId: "trade-test-001" }),
          }),
        );
      });

      it("throws TradeConstraintViolationError on unique constraint violation (P2002)", async () => {
        mockPrisma.trade.upsert.mockRejectedValue(createP2002Error());

        await expect(repository.upsert(upsertRecord)).rejects.toThrow(
          TradeConstraintViolationError,
        );
      });

      it("re-throws unhandled Prisma upsert errors", async () => {
        mockPrisma.trade.upsert.mockRejectedValue(new Error("DB pool exhausted"));

        await expect(repository.upsert(upsertRecord)).rejects.toThrow(
          "DB pool exhausted",
        );
      });
    });

    describe("delete", () => {
      it("deletes and returns the trade when found", async () => {
        mockPrisma.trade.delete.mockResolvedValue(mockTrade);

        const result = await repository.delete("trade-test-001");

        expect(result).toEqual(mockTrade);
        expect(mockPrisma.trade.delete).toHaveBeenCalledWith({
          where: { tradeId: "trade-test-001" },
        });
      });

      it("throws TradeNotFoundError when record to delete is not found (P2025)", async () => {
        mockPrisma.trade.delete.mockRejectedValue(createP2025Error());

        await expect(repository.delete("missing-trade-id")).rejects.toThrow(
          TradeNotFoundError,
        );
      });

      it("re-throws unhandled delete errors", async () => {
        mockPrisma.trade.delete.mockRejectedValue(new Error("Connection lost"));

        await expect(repository.delete("trade-test-001")).rejects.toThrow(
          "Connection lost",
        );
      });
    });
  });

  describe("in-memory fallback and compatibility methods", () => {
    let inMemoryRepo: TradeRepository;

    beforeEach(() => {
      inMemoryRepo = new TradeRepository();
    });

    it("supports getById, upsert, and clear for synchronous in-memory store", () => {
      const record: TradeRecord = {
        id: 99,
        tradeId: "in-mem-trade",
        buyerAddress: "buyer",
        sellerAddress: "seller",
        amountUsdc: "50",
        status: TradeStatus.CREATED,
      };

      inMemoryRepo.upsert(record);
      expect(inMemoryRepo.getById("99")).toEqual(record);

      inMemoryRepo.clear();
      expect(inMemoryRepo.getById("99")).toBeNull();
    });

    it("queries in-memory trades via findById and findByTradeId when prisma is omitted", async () => {
      const record: TradeRecord = {
        id: 77,
        tradeId: "mem-77",
        buyerAddress: "buyer",
        sellerAddress: "seller",
        amountUsdc: "10",
        status: TradeStatus.CREATED,
      };

      inMemoryRepo.upsert(record);
      await expect(inMemoryRepo.findById(77)).resolves.toEqual(record);
      await expect(inMemoryRepo.findByTradeId("mem-77")).resolves.toEqual(record);
      await expect(inMemoryRepo.findByTradeId("mem-999")).resolves.toBeNull();
      await expect(inMemoryRepo.list()).resolves.toEqual([record]);
    });

    it("throws when prisma-only mutations are called without prisma client", async () => {
      await expect(
        inMemoryRepo.create({
          tradeId: "t1",
          buyerAddress: "b",
          sellerAddress: "s",
          amountUsdc: "1",
          buyerLossBps: 5000,
          sellerLossBps: 5000,
        }),
      ).rejects.toThrow("Prisma client required for create");

      await expect(
        inMemoryRepo.update("t1", { status: TradeStatus.FUNDED }),
      ).rejects.toThrow("Prisma client required for update");

      await expect(inMemoryRepo.delete("t1")).rejects.toThrow(
        "Prisma client required for delete",
      );
    });

    it("exports singleton tradeRepository instance", () => {
      expect(tradeRepository).toBeInstanceOf(TradeRepository);
    });
  });
});
