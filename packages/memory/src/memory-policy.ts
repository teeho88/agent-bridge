import type { HybridWeights } from "./embeddings.js";
export type ConsolidationCluster = {
  representativeId: string;
  representativeContent: string;
  supersededIds: string[];
};

export type ConsolidationResult = {
  clusters: ConsolidationCluster[];
  supersededCount: number;
  nextCursor?: string;
};

export type LifecycleConfig = {
  maintenanceEnabled?: boolean;
  maxPoolBytes?: number;
  dedupeThreshold?: number;
  consolidateThreshold?: number;
  minClusterSize?: number;
  decayHalfLifeDays?: number;
  maxPoolSize?: number;
  hybrid?: HybridWeights;
};
