import type {
  OmpProfileCatalog,
  RosterCandidate,
  RosterDeployPlan,
  TeamPlanEntry,
} from "@/shared/api/types";

export function canPreviewRosterDeployment(
  catalog: OmpProfileCatalog | undefined,
  isCatalogLoading: boolean,
  isPending: boolean,
): boolean {
  return !isPending && !isCatalogLoading && catalog?.state === "configured";
}

export function isRosterApplyDisabled(
  plan: Pick<RosterDeployPlan, "applyBlocked" | "counts" | "teams"> | null,
  isPending: boolean,
): boolean {
  return (
    isPending ||
    plan === null ||
    plan.applyBlocked ||
    (plan.counts.applyable === 0 &&
      !plan.teams.some((team) => team.verdict === "create"))
  );
}

function resolveCreatableTeams(
  entries: RosterDeployPlan["entries"],
  teams: TeamPlanEntry[],
): TeamPlanEntry[] {
  return teams.map((team) => {
    if (team.verdict !== "blocked" || team.teamId !== null) return team;

    const memberEntries = team.memberProfiles.map((profile) =>
      entries.find((entry) => entry.name === profile),
    );
    if (
      memberEntries.some(
        (entry) =>
          !entry ||
          !["create", "adopt", "unchanged", "diverged"].includes(entry.verdict),
      )
    ) {
      return team;
    }

    const entriesByProfile = new Map(
      memberEntries.flatMap((entry) => (entry ? [[entry.name, entry]] : [])),
    );
    return {
      ...team,
      verdict: "create",
      members: team.members.map((member) => {
        const entry = entriesByProfile.get(member.profile);
        if (!entry) return member;
        return {
          ...member,
          personaId: entry.verdict === "create" ? null : entry.personaId,
          displayName:
            entry.verdict === "create" ? entry.name : entry.personaDisplayName,
        };
      }),
      message: `${team.name} can be created from the resolved profiles.`,
    };
  });
}

export function rosterCandidatesAvailableToEntry(
  plan: RosterDeployPlan,
  entryName: string,
): RosterCandidate[] {
  const entry = plan.entries.find(
    (candidate) => candidate.name === entryName,
  );
  if (!entry) return [];

  const claimedElsewhere = new Set(
    plan.entries
      .filter(
        (candidate) =>
          candidate.name !== entryName &&
          candidate.via === "userMap" &&
          candidate.personaId !== null,
      )
      .map((candidate) => candidate.personaId),
  );

  return entry.candidates.filter(
    (candidate) =>
      candidate.personaId === entry.personaId ||
      !claimedElsewhere.has(candidate.personaId),
  );
}

export function updateRosterMapping(
  plan: RosterDeployPlan | null,
  entryName: string,
  candidate: RosterCandidate | null,
): RosterDeployPlan | null {
  if (!plan) return plan;

  const entry = plan.entries.find((candidate) => candidate.name === entryName);
  const wasMapped =
    entry?.verdict === "adopt" &&
    entry.via === "userMap" &&
    entry.personaId !== null;
  const wasUnmapped = entry?.verdict === "unmapped";
  const wasCreated =
    entry?.verdict === "create" && entry.candidates.length > 0;
  if (!entry || (!wasMapped && !wasUnmapped && !wasCreated)) return plan;

  const plannedCandidate = candidate
    ? entry.candidates.find(
        (available) =>
          available.personaId === candidate.personaId &&
          available.expectedDigest === candidate.expectedDigest,
      )
    : null;
  if (candidate && !plannedCandidate) return plan;
  if (
    plannedCandidate &&
    plan.entries.some(
      (other) =>
        other.name !== entryName &&
        other.via === "userMap" &&
        other.personaId === plannedCandidate.personaId,
    )
  ) {
    return plan;
  }
  if (
    (wasMapped && plannedCandidate?.personaId === entry.personaId) ||
    (!plannedCandidate && wasUnmapped)
  ) {
    return plan;
  }

  const adopt =
    plan.counts.adopt +
    Number(plannedCandidate !== null) -
    Number(wasMapped);
  const create = plan.counts.create - Number(wasCreated);
  const unmapped =
    plan.counts.unmapped +
    Number(plannedCandidate === null) -
    Number(wasUnmapped);
  const applyable =
    plan.counts.applyable +
    Number(plannedCandidate !== null) -
    Number(wasMapped || wasCreated);

  return {
    ...plan,
    entries: plan.entries.map((current) => {
      if (current.name !== entryName) return current;
      if (plannedCandidate) {
        return {
          ...current,
          verdict: "adopt",
          via: "userMap",
          personaId: plannedCandidate.personaId,
          personaDisplayName: plannedCandidate.displayName,
          expectedDigest: plannedCandidate.expectedDigest,
          message: `Mapped to ${plannedCandidate.displayName}.`,
        };
      }
      return {
        ...current,
        verdict: "unmapped",
        via: null,
        personaId: null,
        personaDisplayName: null,
        expectedDigest: null,
        message: "Choose an agent or deploy a new one.",
      };
    }),
    teams: resolveCreatableTeams(
      plan.entries.map((current) => {
        if (current.name !== entryName) return current;
        if (plannedCandidate) {
          return {
            ...current,
            verdict: "adopt",
            via: "userMap",
            personaId: plannedCandidate.personaId,
            personaDisplayName: plannedCandidate.displayName,
            expectedDigest: plannedCandidate.expectedDigest,
            message: `Mapped to ${plannedCandidate.displayName}.`,
          };
        }
        return {
          ...current,
          verdict: "unmapped",
          via: null,
          personaId: null,
          personaDisplayName: null,
          expectedDigest: null,
          message: "Choose an agent or deploy a new one.",
        };
      }),
      plan.teams,
    ),
    counts: {
      ...plan.counts,
      adopt,
      create,
      unmapped,
      applyable,
    },
    applyBlocked: unmapped > 0 || plan.counts.conflict > 0,
  };
}

export function resolveRosterProfileAsNew(
  plan: RosterDeployPlan | null,
  entryName: string,
): RosterDeployPlan | null {
  if (!plan) return plan;

  const entry = plan.entries.find((candidate) => candidate.name === entryName);
  const wasMapped =
    entry?.verdict === "adopt" &&
    entry.via === "userMap" &&
    entry.personaId !== null;
  const wasUnmapped = entry?.verdict === "unmapped";
  const canCreateFromUnmapped =
    entry?.kind === "unmapped-unaccounted" && (wasUnmapped || wasMapped);
  if (!entry || !canCreateFromUnmapped) return plan;

  const adopt = plan.counts.adopt - Number(wasMapped);
  const create = plan.counts.create + 1;
  const unmapped = plan.counts.unmapped - Number(wasUnmapped);
  const applyable = plan.counts.applyable + Number(wasUnmapped);

  return {
    ...plan,
    entries: plan.entries.map((current) =>
      current.name === entryName
        ? {
            ...current,
            verdict: "create",
            via: null,
            personaId: null,
            personaDisplayName: null,
            expectedDigest: null,
            message: "A new agent will be created for this profile.",
          }
        : current,
    ),
    teams: resolveCreatableTeams(
      plan.entries.map((current) =>
        current.name === entryName
          ? {
              ...current,
              verdict: "create",
              via: null,
              personaId: null,
              personaDisplayName: null,
              expectedDigest: null,
              message: "A new agent will be created for this profile.",
            }
          : current,
      ),
      plan.teams,
    ),
    counts: {
      ...plan.counts,
      adopt,
      create,
      unmapped,
      applyable,
    },
    applyBlocked: unmapped > 0 || plan.counts.conflict > 0,
  };
}
