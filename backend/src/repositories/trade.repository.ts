import { Prisma, PrismaClient, Trade, TradeStatus } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/db";
import type { TradeRecord } from "../types/trade";

export class TradeNotFoundError extends Error {
  status = 404;
  constructor(identifier: string | number) {
    super(`Trade not found: ${identifier}`);
    this.name = "TradeNotFoundError";
  }
}

export class TradeConstraintViolationError extends Error {
  status = 409;
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TradeConstraintViolationError";
  }
}

export type TradeDatabase = Pick<PrismaClient, "trade">;

export class TradeRepository {
  private inMemoryTrades = new Map<string, TradeRecord>();

  constructor(private readonly prisma?: TradeDatabase) {}

  async findById(id: number): Promise<Trade | null> {
    if (this.prisma) {
      return this.prisma.trade.findUnique({ where: { id } });
    }
    const rec = this.inMemoryTrades.get(String(id));
    return rec ? (rec as unknown as Trade) : null;
  }

  async findByTradeId(tradeId: string): Promise<Trade | null> {
    if (this.prisma) {
      return this.prisma.trade.findUnique({ where: { tradeId } });
    }
    for (const trade of this.inMemoryTrades.values()) {
      if (trade.tradeId === tradeId) return trade as unknown as Trade;
    }
    return null;
  }

  async create(
    data: Prisma.TradeCreateInput | Prisma.TradeUncheckedCreateInput,
  ): Promise<Trade> {
    if (!this.prisma) {
      throw new Error("Prisma client required for create");
    }
    try {
      return await this.prisma.trade.create({ data: data as Prisma.TradeCreateInput });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new TradeConstraintViolationError(
          "Unique constraint violation on trade creation",
          error,
        );
      }
      throw error;
    }
  }

  async update(
    tradeId: string,
    data: Prisma.TradeUpdateInput | Prisma.TradeUncheckedUpdateInput,
  ): Promise<Trade> {
    if (!this.prisma) {
      throw new Error("Prisma client required for update");
    }
    try {
      return await this.prisma.trade.update({
        where: { tradeId },
        data,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2025") {
          throw new TradeNotFoundError(tradeId);
        }
        if (error.code === "P2002") {
          throw new TradeConstraintViolationError(
            `Unique constraint violation on trade update: ${tradeId}`,
            error,
          );
        }
      }
      throw error;
    }
  }

  async upsert(
    record: TradeRecord | (Prisma.TradeUpsertArgs["create"] & { id?: number }),
  ): Promise<Trade | void> {
    if (this.prisma) {
      try {
        const tradeData = {
          tradeId: record.tradeId,
          buyerAddress: (record as Record<string, unknown>).buyerAddress as string,
          sellerAddress: (record as Record<string, unknown>).sellerAddress as string,
          amountUsdc: (record as Record<string, unknown>).amountUsdc as string,
          status: record.status ?? TradeStatus.CREATED,
          buyerLossBps:
            ((record as Record<string, unknown>).buyerLossBps as number) ?? 5000,
          sellerLossBps:
            ((record as Record<string, unknown>).sellerLossBps as number) ?? 5000,
        };
        return await this.prisma.trade.upsert({
          where: { tradeId: record.tradeId },
          create: tradeData,
          update: tradeData,
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new TradeConstraintViolationError(
            "Unique constraint violation on trade upsert",
            error,
          );
        }
        throw error;
      }
    }
    this.inMemoryTrades.set(
      String((record as TradeRecord).id ?? record.tradeId),
      record as TradeRecord,
    );
  }

  async delete(tradeId: string): Promise<Trade> {
    if (!this.prisma) {
      throw new Error("Prisma client required for delete");
    }
    try {
      return await this.prisma.trade.delete({ where: { tradeId } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        throw new TradeNotFoundError(tradeId);
      }
      throw error;
    }
  }

  async list(params?: {
    status?: TradeStatus;
    buyerAddress?: string;
    sellerAddress?: string;
    skip?: number;
    take?: number;
  }): Promise<Trade[]> {
    if (!this.prisma) {
      return Array.from(this.inMemoryTrades.values()) as unknown as Trade[];
    }
    return this.prisma.trade.findMany({
      where: {
        ...(params?.status ? { status: params.status } : {}),
        ...(params?.buyerAddress
          ? { buyerAddress: params.buyerAddress.toLowerCase() }
          : {}),
        ...(params?.sellerAddress
          ? { sellerAddress: params.sellerAddress.toLowerCase() }
          : {}),
      },
      skip: params?.skip,
      take: params?.take,
      orderBy: { createdAt: "desc" },
    });
  }

  getById(id: string): TradeRecord | null {
    return this.inMemoryTrades.get(id) ?? null;
  }

  clear(): void {
    this.inMemoryTrades.clear();
  }
}

export const tradeRepository = new TradeRepository(defaultPrisma);
