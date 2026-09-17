import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SnapshotSchema } from "./schema";

export const listUsage = defineRpc({
  name: "session-usage.list",
  input: z.object({ refresh: z.boolean().default(false), revision: z.string().max(100).optional() }),
  output: SnapshotSchema,
});
