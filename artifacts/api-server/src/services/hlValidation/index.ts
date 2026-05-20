// Public surface of the HL Validation suite.
// VALIDATION-ONLY. Never modifies the sealed engine.

export { hlValidationJobs } from "./jobManager";
export { hlValidationForwardJobs } from "./forward";
export { isProfileName } from "./profiles";
export { engineConfigHash, engineGitSha, VALIDATION_SUITE_VERSION } from "./version";
export type {
  ProfileName, RunStatus, RunConfig, RunPhase, ResultClass,
  TradeRecord, FoldStat, ProportionStat, MutationSnapshot,
  BenchmarkKind, ForwardConfig, ForwardStatus,
} from "./types";
