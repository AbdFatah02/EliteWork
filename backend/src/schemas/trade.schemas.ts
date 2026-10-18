import { z } from "zod";
import { TradeStatus } from "@prisma/client";
import { StrKey } from "@stellar/stellar-sdk";
import { createTradeInputSchema } from "./domain/trade";
import {
  MONEY_DECIMALS,
  MoneyConversionError,
  normalizeDecimalString,
  parseDecimalToStroops,
} from "../lib/money";

/**
 * Trade creation validation is the CANONICAL shared domain schema
 * (`./domain/trade`, mirrored in `frontend/src/lib/domain-schemas/trade.ts`),
 * plus backend-only checks the framework-free shared schema can't express:
 * a checksum-accurate Stellar key check, and a real stroop-conversion pass on
 * `amountUsdc` (the shared schema only regex-validates the string shape) so an
 * amount that overflows i128 or loses precision is rejected here rather than
 * deep in a contract call.
 */
export const createTradeSchema = createTradeInputSchema
  .superRefine(
    (data: { buyerAddress?: string; sellerAddress?: string; amountUsdc: string }, ctx: z.RefinementCtx) => {
      for (const field of ["buyerAddress", "sellerAddress"] as const) {
        const value = data[field];
        if (value !== undefined && !StrKey.isValidEd25519PublicKey(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid Stellar public key for ${field}`,
            path: [field],
          });
        }
      }

      try {
        const stroops = parseDecimalToStroops(data.amountUsdc, MONEY_DECIMALS);
        if (stroops <= 0n) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Amount must be positive", path: ["amountUsdc"] });
        }
      } catch (error) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: error instanceof MoneyConversionError ? error.message : "Invalid amount",
          path: ["amountUsdc"],
        });
      }
    },
  )
  .transform((data: { amountUsdc: string; [key: string]: unknown }) => ({
    ...data,
    amountUsdc: normalizeDecimalString(data.amountUsdc, MONEY_DECIMALS),
  }));

export const tradeIdParamSchema = z.object({
  id: z.string().trim().min(1, "Trade ID is required"),
});

/**
 * Bulk-import envelope (issue #45). Each row reuses the single-trade schema
 * so validation stays identical between the UI form and the CSV importer;
 * the 50-row cap keeps one request from monopolizing contract-build RPCs.
 * `cooperativeId`/`region` are optional pilot labels for metrics only — they
 * are recorded when the caller belongs to that cooperative (see ADR-009).
 */
export const bulkTradeBodySchema = z.object({
  trades: z
    .array(createTradeSchema)
    .min(1, "At least one trade is required")
    .max(50, "Maximum 50 trades per request"),
  cooperativeId: z.string().trim().toLowerCase().min(1).max(100).optional(),
  region: z.string().trim().toLowerCase().min(1).max(100).optional(),
});

export const listTradesQuerySchema = z.object({
  status: z.nativeEnum(TradeStatus).optional(),
  page: z.preprocess((val: unknown) => val === undefined ? undefined : Number(val), z.number().int().min(1).default(1)),
  limit: z.preprocess((val: unknown) => val === undefined ? undefined : Number(val), z.number().int().min(1).max(100).default(20)),
  sort: z.string().optional(),
});

export const initiateDisputeSchema = z
  .object({
    reason: z.string().min(10, "Reason must be at least 10 characters"),
    category: z
      .string()
      .trim()
      .min(1, "Category string is required")
      .max(100, "Category must be 100 characters or fewer")
      .optional(),
    categoryId: z.number().int().positive("categoryId must be a positive integer").optional(),
  })
  .superRefine((data: { category?: string; categoryId?: number }, ctx: z.RefinementCtx) => {
    if (!data.category && data.categoryId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Category string is required",
        path: ["category"],
      });
    }
  });
