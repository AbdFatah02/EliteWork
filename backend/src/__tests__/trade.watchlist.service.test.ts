import {
  Prisma,
  Trade,
  TradeStatus,
  UserWatchlist,
} from "@prisma/client";
import { TradeWatchlistService } from "../services/trade.watchlist.service";

describe("TradeWatchlistService", () => {
  const trade: Trade = {
    id: 1,
    tradeId: "trade-1",
    buyerAddress: "g-user",
    sellerAddress: "g-seller",
    amountUsdc: "100",
    buyerLossBps: 5000,
    sellerLossBps: 5000,
    version: 0,
    status: TradeStatus.CREATED,
    fundedAt: null,
    deliveredAt: null,
    completedAt: null,
    expiresAt: null,
    expiredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const watch: UserWatchlist = {
    id: 1,
    userAddress: "g-user",
    tradeId: "trade-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  type WatchlistWithTrade = Prisma.UserWatchlistGetPayload<{
    include: { trade: true };
  }>;
  type WatchlistDatabase = ConstructorParameters<typeof TradeWatchlistService>[0];
  const prisma = {
    trade: {
      findUnique: jest.fn<Promise<Trade | null>, [args: Prisma.TradeFindUniqueArgs]>(),
    },
    userWatchlist: {
      upsert: jest.fn<Promise<UserWatchlist>, [args: Prisma.UserWatchlistUpsertArgs]>(),
      deleteMany: jest.fn<
        Promise<Prisma.BatchPayload>,
        [args: Prisma.UserWatchlistDeleteManyArgs]
      >(),
      findMany: jest.fn<
        Promise<WatchlistWithTrade[]>,
        [args: Prisma.UserWatchlistFindManyArgs]
      >(),
    },
  };
  const service = new TradeWatchlistService(
    prisma as unknown as WatchlistDatabase,
  );

  beforeEach(() => jest.clearAllMocks());

  it("adds one user-scoped watch and delegates duplicate prevention to the composite key", async () => {
    prisma.trade.findUnique.mockResolvedValue(trade);
    prisma.userWatchlist.upsert.mockResolvedValue(watch);
    await expect(service.add("trade-1", "G-USER")).resolves.toEqual(watch);
    expect(prisma.userWatchlist.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userAddress_tradeId: { userAddress: "g-user", tradeId: "trade-1" } },
    }));
  });

  it("removes a watch idempotently", async () => {
    prisma.trade.findUnique.mockResolvedValue(trade);
    prisma.userWatchlist.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove("trade-1", "g-user")).resolves.toEqual({ removed: false });
  });

  it("lists the caller's watched trades in bookmark order", async () => {
    prisma.userWatchlist.findMany.mockResolvedValue([{ ...watch, trade }]);
    const result = await service.list("G-USER");
    expect(result).toEqual([{ ...trade, watchedAt: watch.createdAt }]);
    expect(prisma.userWatchlist.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userAddress: "g-user" },
    }));
  });
});
