import { z } from "zod";

export const ROUTING_NOTE_KIND = "routing-note";
export const ROUTING_NOTE_VERSION = 1;
export const ROUTING_PLUGIN_ID = "profile-routing";

export const RoutingNoteDataSchema = z.object({
  continued: z.boolean(),
  modelId: z.string().min(1),
  provider: z.string().min(1),
  delegateId: z.string().min(1),
});

export type RoutingNoteData = z.infer<typeof RoutingNoteDataSchema>;

export function routingNoteText(note: RoutingNoteData): string {
  const verb = note.continued ? "Continuing with" : "Routing to";
  const prep = note.continued ? "in" : "as";
  return `${verb} ${note.modelId} (${note.provider}) ${prep} ${note.delegateId}.`;
}
