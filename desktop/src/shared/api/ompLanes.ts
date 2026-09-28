import { invokeTauri } from "@/shared/api/tauri";

export type OmpLaneEntry = {
  key: string;
  label: string;
  model: string;
  aliasOf: string | null;
  effort: string | null;
  usedBy: string[];
};

export type OmpLaneEditorState = {
  state: "configured" | "unavailable" | "invalid";
  repoPath: string | null;
  lanes: OmpLaneEntry[];
  deadIds: string[];
  providers: string[];
  unavailableReason: string | null;
  stale: boolean;
};

export type OmpHostIdentity = {
  executable: string;
  version: string;
  configRoot: string;
  managed: boolean;
};

export type OmpModelChoice = {
  selector: string;
  name: string;
  efforts: string[];
  reasoning: boolean;
  dead: boolean;
};

export type OmpModelCatalog = {
  models: OmpModelChoice[];
  fetchedAt: string;
  host: OmpHostIdentity;
};

export type OmpLaneProblem = {
  code: string;
  lane: string | null;
  message: string;
};

export type OmpLanePreview = {
  ok: boolean;
  revision: string;
  diff: string;
  problems: OmpLaneProblem[];
  resolved: Array<{ key: string; model: string; effort: string | null; source: string }>;
  affectedProfiles: string[];
  runningAgents: Array<Record<string, unknown>>;
  host: OmpHostIdentity;
};

export type OmpLaneSaveOutcome = {
  source: "notAttempted" | "written" | "failed";
  profiles: Array<{ profile: string; state: string; detail: string | null }>;
  records: Array<{ profile: string; record: string; state: string; detail: string | null }>;
  backups: string | null;
  recovery: string[];
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type OmpLaneRepoStatus = {
  gitPresent: boolean;
  lanesDirty: boolean;
  lanesRevision: string | null;
  unrelatedDirtyPaths: string[];
  head: string | null;
};

export type OmpLaneCommitOutcome = {
  committed: boolean;
  sha: string | null;
  branch: string | null;
  refused: string | null;
  output: string;
};

export function getOmpLaneEditorState(): Promise<OmpLaneEditorState> {
  return invokeTauri("get_omp_lane_editor_state");
}

export function getOmpModelCatalog(repoPath: string): Promise<OmpModelCatalog> {
  return invokeTauri("get_omp_model_catalog", { repoPath });
}

export function previewOmpLanes(
  repoPath: string,
  lanes: OmpLaneEntry[],
): Promise<OmpLanePreview> {
  return invokeTauri("preview_omp_lanes", { repoPath, lanes });
}

export function saveOmpLanes(
  repoPath: string,
  lanes: OmpLaneEntry[],
  revision: string,
): Promise<OmpLaneSaveOutcome> {
  return invokeTauri("save_omp_lanes", { repoPath, lanes, revision });
}

export function getOmpLaneRepoStatus(repoPath: string): Promise<OmpLaneRepoStatus> {
  return invokeTauri("get_omp_lane_repo_status", { repoPath });
}

export function commitOmpLanes(
  repoPath: string,
  revision: string,
): Promise<OmpLaneCommitOutcome> {
  return invokeTauri("commit_omp_lanes", { repoPath, revision });
}
export function prepareOmpLaneModelChange(
  repoPath: string,
  laneKey: string,
  model: string,
): Promise<OmpLaneEntry[]> {
  return invokeTauri("prepare_omp_lane_model_change", {
    repoPath,
    laneKey,
    model,
  });
}
