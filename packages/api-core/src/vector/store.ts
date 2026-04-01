export type VectorStoreHealth = {
  ok: boolean;
  error: string | null;
};

export type VectorNeighbor = {
  threadId: number;
  score: number;
};

export type VectorQueryParams = {
  storePath: string;
  dimensions: number;
  vector: number[];
  limit: number;
  candidateK?: number;
  excludeThreadId?: number;
  efSearch?: number;
};

export type VectorStore = {
  checkRuntime: () => VectorStoreHealth;
  resetRepository: (params: { storePath: string; dimensions: number }) => void;
  upsertVector: (params: { storePath: string; dimensions: number; threadId: number; vector: number[] }) => void;
  deleteVector: (params: { storePath: string; dimensions: number; threadId: number }) => void;
  queryNearest: (params: VectorQueryParams) => VectorNeighbor[];
  close: () => void;
};
