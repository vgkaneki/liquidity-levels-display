// Inlined from lib/api-zod/src/generated/api.ts (the only @workspace/* import
// the engine had). Kept verbatim so the validation behavior is identical to
// the monorepo source. See README.md for context.
import { z as zod } from "zod";

export const GetLevelsQueryParams = zod.object({
  symbol: zod.coerce.string(),
  interval: zod.coerce.string(),
});

export type GetLevelsParams = {
  symbol: string;
  interval: string;
};
