import * as React from "react";
import { Route } from "@/app/routes/settings";
import { SettingsOptionGroup } from "./SettingsOptionGroup";
import { Button } from "@/shared/ui/button";
import { Spinner } from "@/shared/ui/spinner";
import {
  commitOmpLanes,
  getOmpLaneEditorState,
  getOmpLaneRepoStatus,
  getOmpModelCatalog,
  prepareOmpLaneModelChange,
  previewOmpLanes,
  saveOmpLanes,
  type OmpLaneEntry,
  type OmpLanePreview,
  type OmpModelCatalog,
} from "@/shared/api/ompLanes";

export function RoutingLanesSettingsCard() {
  const { lane: handoffLane, model: handoffModel, profile } = Route.useSearch();
  const [repoPath, setRepoPath] = React.useState<string | null>(null);
  const [lanes, setLanes] = React.useState<OmpLaneEntry[]>([]);
  const [catalog, setCatalog] = React.useState<OmpModelCatalog | null>(null);
  const [preview, setPreview] = React.useState<OmpLanePreview | null>(null);
  const [revision, setRevision] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<string | null>(null);
  const [sidecarStale, setSidecarStale] = React.useState(false);
  const [commitNotice, setCommitNotice] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void getOmpLaneEditorState().then(async (state) => {
      if (cancelled) return;
      if (state.state !== "configured" || !state.repoPath) {
        setError(state.unavailableReason ?? "Locate the oh-my-buzz repository to edit lanes.");
        return;
      }
      setRepoPath(state.repoPath);
      setSidecarStale(state.stale);
      const draft =
        handoffLane && handoffModel
          ? await prepareOmpLaneModelChange(state.repoPath, handoffLane, handoffModel)
          : state.lanes;
      if (cancelled) return;
      setLanes(draft);
      try {
        const [models, status] = await Promise.all([
          getOmpModelCatalog(state.repoPath),
          getOmpLaneRepoStatus(state.repoPath),
        ]);
        if (cancelled) return;
        setCatalog(models);
        setDirty(status.lanesDirty);
        setRevision(status.lanesRevision);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [handoffLane, handoffModel]);

  const updateLane = (key: string, patch: Partial<OmpLaneEntry>) => {
    setLanes((current) => current.map((lane) => lane.key === key ? { ...lane, ...patch } : lane));
    setPreview(null);
  };

  const handlePreview = async () => {
    if (!repoPath) return;
    setBusy(true);
    setError(null);
    try {
      const next = await previewOmpLanes(repoPath, lanes);
      setPreview(next);
      setRevision(next.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!repoPath || !revision || !preview?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await saveOmpLanes(repoPath, lanes, revision);
      setResult(`${outcome.source}; ${outcome.profiles.map((item) => `${item.profile}: ${item.state}${item.detail ? ` (${item.detail})` : ""}`).join(", ")}\n${outcome.records.map((item) => `${item.profile}.${item.record}: ${item.state}${item.detail ? ` (${item.detail})` : ""}`).join("\n")}\n${outcome.stdout}\n${outcome.stderr}`);
      setDirty(outcome.source === "written");
      setCommitNotice(outcome.source === "written");
      if (outcome.recovery.length > 0) setError(outcome.recovery.join("\n"));
      const status = await getOmpLaneRepoStatus(repoPath);
      setDirty(status.lanesDirty);
      setRevision(status.lanesRevision);
      setPreview(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      if (message.includes("stale_source:") && repoPath) {
        try {
          const refreshed = await previewOmpLanes(repoPath, lanes);
          setPreview(refreshed);
          setRevision(refreshed.revision);
        } catch (refreshReason) {
          setError(`${message}\nCould not refresh the diff: ${refreshReason instanceof Error ? refreshReason.message : String(refreshReason)}`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!repoPath || !revision) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await commitOmpLanes(repoPath, revision);
      if (!outcome.committed) {
        setError(`${outcome.refused ?? "commit refused"}: ${outcome.output}`);
      } else {
        setResult(`Committed ${outcome.sha ?? "lanes.json"} on ${outcome.branch ?? "current branch"}.`);
        setCommitNotice(false);
        const status = await getOmpLaneRepoStatus(repoPath);
        setDirty(status.lanesDirty);
        setRevision(status.lanesRevision);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsOptionGroup
      data-testid="settings-routing-lanes"
      description="Edit the shared model lanes used by omp profiles and automatic routing. Lane changes apply to agents started after the save; Auto reads lane values on its own schedule."
      title="Routing lanes"
    >
      <div className="space-y-4 px-4 py-4">
        {handoffLane && handoffModel ? (
          <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm" role="status">
            Drafting <strong>{handoffModel}</strong> for lane <strong>{handoffLane}</strong>
            {profile ? ` used by ${profile}` : ""}. Review the preview before saving.
          </p>
        ) : null}
        {sidecarStale ? <p className="text-sm text-muted-foreground" role="status">The lane file differs from the last applied host snapshot. Review the preview before saving.</p> : null}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        {catalog ? <p className="text-xs text-muted-foreground">Host: {catalog.host.executable} · {catalog.host.version}</p> : null}
        {lanes.map((lane) => (
          <div className="grid gap-2 border-b border-border/50 pb-3 sm:grid-cols-[10rem_minmax(0,1fr)_9rem]" key={lane.key}>
            <div className="min-w-0">
              <p className="font-medium">{lane.label}</p>
              <p className="text-xs text-muted-foreground">{lane.key}</p>
              <p className="text-xs text-muted-foreground">Used by: {lane.usedBy.join(", ") || "No current consumers"}</p>
            </div>
            <label className="sr-only" htmlFor={`lane-model-${lane.key}`}>{lane.label} model</label>
            <select
              className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
              disabled={!catalog || busy}
              id={`lane-model-${lane.key}`}
              onChange={(event) => updateLane(lane.key, { model: event.target.value, aliasOf: null })}
              value={lane.model.startsWith("@") ? lane.model : lane.model}
            >
              {lane.model.startsWith("@") ? <option value={lane.model}>{lane.model} (lane alias)</option> : null}
              {catalog?.models.map((model) => (
                <option disabled={model.dead} key={model.selector} value={model.selector}>
                  {model.name}{model.dead ? " (unavailable on this account)" : ""}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`lane-effort-${lane.key}`}>{lane.label} effort</label>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              disabled={!catalog || busy || (catalog.models.find((model) => model.selector === lane.model)?.efforts.length ?? 0) === 0}
              id={`lane-effort-${lane.key}`}
              onChange={(event) => updateLane(lane.key, { effort: event.target.value || null })}
              value={lane.effort ?? ""}
            >
              <option value="">No effort</option>
              {catalog?.models.find((model) => model.selector === lane.model)?.efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
            </select>
          </div>
        ))}
        {preview ? (
          <section className="space-y-2 rounded-md border p-3" aria-label="Lane change preview">
            <h3 className="font-medium">Preview</h3>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{preview.diff}</pre>
            {preview.problems.map((problem, index) => <p className="text-sm text-destructive" key={`${problem.code}-${index}`}>{problem.code}{problem.lane ? ` (${problem.lane})` : ""}: {problem.message}</p>)}
            {preview.ok ? <Button disabled={busy} onClick={() => void handleSave()} type="button">Confirm and save lanes</Button> : null}
          </section>
        ) : null}
        {result ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs" role="status">{result}</pre> : null}
        {commitNotice ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border p-3" role="status">
            <span className="text-sm">profiles/lanes.json changed. Commit? <code>chore(routing): update lanes from Buzz</code></span>
            <Button disabled={busy} onClick={() => void handleCommit()} type="button">Commit</Button>
            <Button disabled={busy} onClick={() => setCommitNotice(false)} type="button" variant="ghost">Later</Button>
          </div>
        ) : null}
        <div className="flex gap-2">
          <Button disabled={!repoPath || !catalog || busy} onClick={() => void handlePreview()} type="button">
            {busy ? <Spinner /> : null} Preview changes
          </Button>
          {dirty && !commitNotice ? <Button disabled={!revision || busy} onClick={() => setCommitNotice(true)} type="button" variant="outline">Commit lanes</Button> : null}
        </div>
      </div>
    </SettingsOptionGroup>
  );
}
