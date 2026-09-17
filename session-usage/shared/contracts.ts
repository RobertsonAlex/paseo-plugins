import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AllowancesSchema } from "./allowance";
import { SnapshotSchema } from "./schema";

export const listUsage = defineRpc({
  name: "session-usage.list",
  input: z.object({ refresh: z.boolean().default(false), revision: z.string().max(100).optional() }),
  output: SnapshotSchema,
});

export const listAllowances = defineRpc({
  name: "session-usage.allowances",
  input: z.object({ refresh: z.boolean().default(false) }),
  output: AllowancesSchema,
});
