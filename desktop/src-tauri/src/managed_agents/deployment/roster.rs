//! The roster deploy plan: one reconcile function shared by the preview and
//! the apply path, so the pane and the handler cannot disagree.
//!
//! Pure and `AppHandle`-free — every input is passed in — so the plan can be
//! unit-tested against fixture stores and replayed read-only over a real
//! `agents/managed-agents.json`.
//!
//! Two fields with two different jobs (M2 plan, "Identity and keying"):
//!
//! * [`AgentDefinition::deployment_identity`] is immutable and answers "did
//!   deployment already create this?". It is the only adoption evidence.
//! * `env_vars.OMP_PROFILE` is user-editable and answers "what does it run
//!   as?". It is never restored from provenance.
//!
//! When they disagree the row is `diverged`: displayed, never auto-repaired.
//! A `display_name` equal to a profile name is always a conflict, never
//! adoption evidence.

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::managed_agents::config_bridge::OmpProfileCatalogEntry;
use crate::managed_agents::{AgentDefinition, DeploymentIdentity, TeamRecord};

/// Local content hash of one store row, used as the plan's `expectedDigest`.
///
/// Serializing the whole row (not a hand-picked projection) is deliberate: any
/// intervening write — a prompt edit, a selector change, a rename — must move
/// the digest, because the point of revalidation is "did anything change while
/// the user was looking", not "did the fields I happen to write change".
pub(crate) fn digest_of<T: Serialize>(value: &T) -> String {
    let canonical = serde_json::to_string(value).unwrap_or_default();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

/// The profile-name grammar the manifest reader enforces
/// (`config_bridge/reader.rs` `valid_profile_name`). Duplicated here so the
/// planner can classify a malformed selector as malformed rather than as
/// merely not-installed; the reader stays the authority for what may be read.
fn valid_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RosterVerdict {
    /// Nothing deployed or mapped here; apply creates it.
    Create,
    /// An existing row may claim this profile by provenance or explicit user
    /// mapping; apply patches only its identity keys.
    Adopt,
    /// Deployed for this profile; apply writes nothing.
    Unchanged,
    /// Deployed for this profile, but the selector was since edited by the
    /// user. Reported, never repaired.
    Diverged,
    /// A legacy row that could not be mapped unambiguously. A question, not an
    /// action: apply is refused until the user answers.
    Unmapped,
    /// Deployment must not proceed for this profile.
    Conflict,
    /// Catalogue-only: the profile cannot be deployed on this machine yet.
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RosterVerdictKind {
    NameTaken,
    NameTakenNonOmp,
    /// Informational: the profile is already bound under another display name.
    ProfileClaimed,
    /// Existing selector holders make a new persona with this profile unsafe.
    UnmappedClaimants,
    /// The candidate rows do not hold the profile's selector.
    UnmappedUnaccounted,
    /// An `omp` persona carries a present selector that fails the profile-name
    /// grammar, so no manifest could ever declare it.
    ManualValue,
    DivergedCleared,
    DivergedReassigned,
    /// Two rows claim the same profile by provenance. Deployment writes this
    /// field exactly once per profile, so this is store damage (a restored
    /// backup, a hand edit) — reported, never repaired.
    DuplicateDeployment,
    /// The catalogue no longer declares the profile a persona selects.
    NotInstalled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdoptVia {
    Provenance,
    UserMap,
}

/// One persona a user could map an `unmapped` profile onto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterCandidate {
    pub persona_id: String,
    pub display_name: String,
    pub expected_digest: String,
}

/// One catalogue entry's verdict. Exactly one array in the plan's shape would
/// hold it; the verdict tag is carried here so an entry can never appear in
/// two lists at once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterPlanEntry {
    /// The profile name — the entry's identity key.
    pub name: String,
    pub verdict: RosterVerdict,
    pub kind: Option<RosterVerdictKind>,
    /// Set for `adopt` only.
    pub via: Option<AdoptVia>,
    /// The target persona, when the verdict is about an existing row.
    pub persona_id: Option<String>,
    pub persona_display_name: Option<String>,
    /// The selector the target row currently carries, when it carries one.
    pub current_selector: Option<String>,
    /// Why the verdict is what it is, in the user's words.
    pub message: String,
    /// For `unavailable`: the failing gate's reason.
    pub detail: Option<String>,
    /// For `unmapped`: the rows the user may choose between.
    pub candidates: Vec<RosterCandidate>,
    /// Declared rule paths for a profile being created.
    pub rule_paths: Vec<String>,
    /// Declared plugin names for a profile being created.
    pub plugin_names: Vec<String>,
    /// The lane this profile's plugins and role text run under.
    pub model_lane: String,
    /// Content hash of the row(s) the verdict was computed from. `None` for
    /// `create` (no row yet) and `unavailable`; those are revalidated by their
    /// key and verdict instead.
    pub expected_digest: Option<String>,
}

/// A persona that selects a profile the catalogue no longer declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotInstalledEntry {
    pub persona_id: String,
    pub display_name: String,
    pub selector: String,
    pub message: String,
}

/// A persona carrying a present-but-malformed selector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualValueEntry {
    pub persona_id: String,
    pub display_name: String,
    pub selector: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TeamPresetVerdict {
    /// No team carries this preset slug; apply creates it.
    Create,
    /// The slug is present and its content still matches the preset. No write.
    Unchanged,
    /// The slug is present and the user changed it. Preserved verbatim.
    Edited,
    /// A member could not be resolved, so the team is not partially created.
    Blocked,
}

/// How one preset member resolved to a persona.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberResolution {
    /// The member's profile — the preset declares profiles, not persona ids.
    pub profile: String,
    pub persona_id: Option<String>,
    pub display_name: Option<String>,
    pub message: String,
}

/// One preset team's verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPlanEntry {
    pub slug: String,
    pub name: String,
    pub version: String,
    pub verdict: TeamPresetVerdict,
    /// The existing team carrying this slug, when there is one.
    pub team_id: Option<String>,
    /// Every member resolved *before* the team exists; a team with any
    /// unresolvable member is `blocked` and is not partially created.
    pub members: Vec<TeamMemberResolution>,
    pub message: String,
    /// For `create`: the content hash the preset will produce. For the other
    /// verdicts: the existing team's content hash. Revalidation compares this.
    pub expected_digest: Option<String>,
    /// The members, as personas, shared across presets — listed once each in
    /// the plan's `sharedMembers` disclosure.
    pub member_profiles: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCounts {
    pub create: usize,
    pub adopt: usize,
    pub unchanged: usize,
    pub diverged: usize,
    pub unmapped: usize,
    pub conflict: usize,
    pub unavailable: usize,
    pub applyable: usize,
}

/// The whole plan. `entries` is the roster; the plan's named arrays are the
/// same entries filtered by [`RosterPlanEntry::verdict`], so a second list can
/// never drift from the first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterDeployPlan {
    /// The ambient entry the catalogue always declares (`default`), whose
    /// exclusion from `create` is derived here rather than hardcoded in the UI.
    pub ambient: Option<String>,
    pub entries: Vec<RosterPlanEntry>,
    pub not_installed: Vec<NotInstalledEntry>,
    pub manual_value: Vec<ManualValueEntry>,
    pub teams: Vec<TeamPlanEntry>,
    /// Personas that belong to more than one planned preset, named with every
    /// preset that uses them — the disclosure a shared persona needs.
    pub shared_members: Vec<SharedMember>,
    pub counts: PlanCounts,
    /// True when apply must stay disabled: a conflict or an unanswered
    /// question is pending.
    pub apply_blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMember {
    pub persona_id: String,
    pub display_name: String,
    pub preset_slugs: Vec<String>,
}

/// A user's answer to an `unmapped` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMapping {
    pub name: String,
    pub persona_id: String,
}

/// The canonical content a preset team would persist, digested for the
/// `unchanged`/`edited` comparison. Membership is an input, so an edited roster
/// wins and reads as `edited` rather than being silently re-added.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamPresetContent<'a> {
    pub name: &'a str,
    pub description: Option<&'a str>,
    pub instructions: Option<&'a str>,
    pub persona_ids: &'a [String],
}

pub(crate) fn team_content_digest(team: &TeamRecord) -> String {
    digest_of(&TeamPresetContent {
        name: &team.name,
        description: team.description.as_deref(),
        instructions: team.instructions.as_deref(),
        persona_ids: &team.persona_ids,
    })
}

pub(crate) fn preset_content_digest(
    name: &str,
    description: Option<&str>,
    persona_ids: &[String],
) -> String {
    digest_of(&TeamPresetContent {
        name,
        description,
        // A preset never ships team instructions.
        instructions: None,
        persona_ids,
    })
}

/// The selector a row carries, distinguishing "absent" from "present empty".
fn selector_of(persona: &AgentDefinition) -> Option<String> {
    persona.env_vars.get("OMP_PROFILE").cloned()
}

fn deployed_profile(persona: &AgentDefinition) -> Option<&str> {
    persona
        .deployment_identity
        .as_ref()
        .map(|identity| identity.profile.as_str())
}

/// Rows an adoption may target: `OMP_PROFILE` on a non-omp runtime is rejected
/// by `commands/personas/mod.rs`, and changing that row's runtime to make it
/// eligible would be a second, larger overwrite.
fn is_eligible_target(persona: &AgentDefinition) -> bool {
    persona.runtime.as_deref() == Some("omp")
}

fn display_of(persona: &AgentDefinition) -> String {
    persona.display_name.clone()
}

/// Every persona whose selector names `profile` and which is not already
/// claimed by another profile's provenance, in store order.
///
/// A row carrying provenance for `X` answers "already deployed" for `X` and can
/// never be the adoption target for `Y`: provenance is immutable, so a second
/// claim would be a rewrite of the first.
fn holders<'a>(personas: &'a [AgentDefinition], profile: &str) -> Vec<&'a AgentDefinition> {
    personas
        .iter()
        .filter(|persona| selector_of(persona).as_deref() == Some(profile))
        .filter(|persona| {
            deployed_profile(persona)
                .map(|deployed| deployed == profile)
                .unwrap_or(true)
        })
        .collect()
}

/// Rows whose profile cannot be established: an `omp` persona with neither
/// deployment provenance nor a non-blank selector (and not a built-in, which is
/// a shipped record rather than a deployment candidate).
fn unaccounted_rows(personas: &[AgentDefinition]) -> Vec<&AgentDefinition> {
    personas
        .iter()
        .filter(|persona| is_eligible_target(persona))
        .filter(|persona| deployed_profile(persona).is_none())
        .filter(|persona| !persona.is_builtin)
        .filter(|persona| {
            selector_of(persona)
                .map(|value| value.trim().is_empty())
                .unwrap_or(true)
        })
        .collect()
}

/// The unambiguous-mapping test from the plan's "Provenance migration":
/// a row may claim a profile by provenance only when the mapping cannot be
/// read two ways. Anything else needs an explicit user choice.
///
/// A `display_name` match is *not* part of this test — it is a conflict signal,
/// and it disqualifies the row rather than justifying adoption.
fn unambiguous_claim<'a>(
    personas: &'a [AgentDefinition],
    profile: &str,
    holder: &'a AgentDefinition,
) -> bool {
    is_eligible_target(holder)
        && holders(personas, profile).len() == 1
        && !personas
            .iter()
            .any(|persona| persona.id != holder.id && persona.display_name == profile)
}

fn candidate(persona: &AgentDefinition) -> RosterCandidate {
    RosterCandidate {
        persona_id: persona.id.clone(),
        display_name: persona.display_name.clone(),
        expected_digest: digest_of(persona),
    }
}

fn entry_for(
    declaration: &OmpProfileCatalogEntry,
    verdict: RosterVerdict,
    kind: Option<RosterVerdictKind>,
    message: String,
) -> RosterPlanEntry {
    RosterPlanEntry {
        name: declaration.name.clone(),
        verdict,
        kind,
        via: None,
        persona_id: None,
        persona_display_name: None,
        current_selector: None,
        message,
        detail: None,
        candidates: Vec::new(),
        rule_paths: declaration.rule_paths.clone(),
        plugin_names: declaration.plugin_names.clone(),
        model_lane: declaration.model_lane.clone(),
        expected_digest: None,
    }
}

/// Compute the plan.
///
/// * `declarations` is the installer-owned catalogue, exactly as the Rust
///   reader projects it — the pane therefore reads the same catalogue the
///   reader does, and "is this profile installed" has one answer.
/// * `mappings` are the user's answers to previous `unmapped` entries. Passing
///   them turns an `unmapped` entry into an `adopt` with `via: userMap`, which
///   is what makes apply-time revalidation a recompute rather than a diff.
pub fn plan_roster_deploy(
    declarations: &[OmpProfileCatalogEntry],
    personas: &[AgentDefinition],
    teams: &[TeamRecord],
    gates: &super::activation::ActivationGates,
    mappings: &[ProfileMapping],
) -> RosterDeployPlan {
    let declared_names: Vec<&str> = declarations
        .iter()
        .map(|declaration| declaration.name.as_str())
        .collect();
    let mut entries = Vec::new();
    let ambient = declarations
        .iter()
        .find(|declaration| declaration.name == "default")
        .map(|declaration| declaration.name.clone());

    for declaration in declarations {
        let name = declaration.name.as_str();
        // `default` is the ambient fallback, not a role: an absent selector
        // already resolves to it in the reader. Derived from the catalogue
        // name, never from a literal in the UI.
        if declaration.name == "default" {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Unchanged,
                None,
                "Machine fallback. Used when no profile is selected.".to_string(),
            );
            entry.persona_id = personas
                .iter()
                .find(|persona| selector_of(persona).as_deref() == Some(name))
                .map(|persona| persona.id.clone());
            entry.expected_digest = personas
                .iter()
                .find(|persona| persona.id == entry.persona_id.clone().unwrap_or_default())
                .map(digest_of);
            entries.push(entry);
            continue;
        }

        // The activation gate is consulted HERE, not by the caller, so a
        // gated profile cannot be created by a caller that forgot to pass the
        // gate list. Rust keeps the last word because this is the same read
        // `commands/personas` performs before any write.
        let gate = gates.state(name);
        if let Some(reason) = gate.reason() {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Unavailable,
                None,
                format!("Deploying profile `{name}` is unavailable on this machine: {reason}"),
            );
            entry.detail = Some(reason.to_string());
            entries.push(entry);
            continue;
        }

        let deployed: Vec<&AgentDefinition> = personas
            .iter()
            .filter(|persona| deployed_profile(persona) == Some(name))
            .collect();

        if deployed.len() > 1 {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Conflict,
                Some(RosterVerdictKind::DuplicateDeployment),
                format!(
                    "{} agents record a deployment for `{name}` ({}). Deployment writes this once per profile; the store needs repair before it can be reconciled.",
                    deployed.len(),
                    deployed
                        .iter()
                        .map(|persona| display_of(persona))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            );
            entry.persona_id = Some(deployed[0].id.clone());
            entry.persona_display_name = Some(display_of(deployed[0]));
            entry.expected_digest = Some(digest_of(deployed[0]));
            entries.push(entry);
            continue;
        }

        if let Some(row) = deployed.first() {
            let selector = selector_of(row);
            let mut entry = if selector.as_deref() == Some(name) {
                entry_for(
                    declaration,
                    RosterVerdict::Unchanged,
                    Some(RosterVerdictKind::ProfileClaimed),
                    format!(
                        "Profile `{name}` is already bound to `{}`. Deployment will leave it alone.",
                        display_of(row)
                    ),
                )
            } else {
                let cleared = selector.as_deref().unwrap_or("").trim().is_empty();
                let mut diverged = entry_for(
                    declaration,
                    RosterVerdict::Diverged,
                    Some(if cleared {
                        RosterVerdictKind::DivergedCleared
                    } else {
                        RosterVerdictKind::DivergedReassigned
                    }),
                    if cleared {
                        format!(
                            "`{}` was deployed for `{name}` but no longer selects it. Deployment will not restore it — set it again if that was unintended.",
                            display_of(row)
                        )
                    } else {
                        format!(
                            "`{}` was deployed for `{name}` and now selects `{}`. Left as is.",
                            display_of(row),
                            selector.as_deref().unwrap_or_default()
                        )
                    },
                );
                diverged.current_selector = selector.clone();
                diverged
            };
            entry.persona_id = Some(row.id.clone());
            entry.persona_display_name = Some(display_of(row));
            entry.expected_digest = Some(digest_of(row));
            entries.push(entry);
            continue;
        }

        // A row deployed for a DIFFERENT profile now selects this one. The
        // selector is consumed — `commands/personas/mod.rs` refuses a second
        // persona holding the same `OMP_PROFILE` — and provenance is immutable,
        // so neither adopting it nor minting a duplicate is available.
        // Deployment leaves it alone and says what it saw.
        if let Some(foreign) = personas.iter().find(|persona| {
            selector_of(persona).as_deref() == Some(name)
                && deployed_profile(persona).is_some_and(|deployed| deployed != name)
        }) {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Unchanged,
                Some(RosterVerdictKind::ProfileClaimed),
                format!(
                    "Profile `{name}` is already bound to `{}`, which is deployed for `{}`. Deployment will leave it alone.",
                    display_of(foreign),
                    deployed_profile(foreign).unwrap_or("another profile")
                ),
            );
            entry.persona_id = Some(foreign.id.clone());
            entry.persona_display_name = Some(display_of(foreign));
            entry.current_selector = selector_of(foreign);
            entry.expected_digest = Some(digest_of(foreign));
            entries.push(entry);
            continue;
        }

        // Not deployed. A claim may still exist — a legacy row the previous
        // roster wrote (it recorded no provenance), or an explicit user map.
        let mapped = mappings
            .iter()
            .find(|mapping| mapping.name == name)
            .and_then(|mapping| {
                personas
                    .iter()
                    .find(|persona| persona.id == mapping.persona_id)
            })
            .filter(|persona| is_eligible_target(persona))
            .filter(|persona| deployed_profile(persona).is_none());

        if let Some(row) = mapped {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Adopt,
                None,
                format!(
                    "`{}` will be adopted as the deployed `{name}`.",
                    display_of(row)
                ),
            );
            entry.via = Some(AdoptVia::UserMap);
            entry.persona_id = Some(row.id.clone());
            entry.persona_display_name = Some(display_of(row));
            entry.current_selector = selector_of(row);
            entry.expected_digest = Some(digest_of(row));
            entries.push(entry);
            continue;
        }

        // A row the previous roster wrote carries no provenance, so its only
        // link back to the profile is its selector. Exactly one eligible holder
        // with no same-named competitor is an unambiguous mapping; anything
        // else is a question for the user, never a guess.
        let claimants = holders(personas, name);
        if claimants.len() == 1 && unambiguous_claim(personas, name, claimants[0]) {
            let row = claimants[0];
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Adopt,
                None,
                format!(
                    "`{}` was deployed for `{name}` before provenance was recorded; adopting it keeps the existing agent.",
                    display_of(row)
                ),
            );
            entry.via = Some(AdoptVia::Provenance);
            entry.persona_id = Some(row.id.clone());
            entry.persona_display_name = Some(display_of(row));
            entry.current_selector = selector_of(row);
            entry.expected_digest = Some(digest_of(row));
            entries.push(entry);
            continue;
        }

        // No selector links any row to this profile. A name-only match is
        // always a conflict: it may be the deployed persona, an unrelated omp
        // persona, or a non-omp one, and only the user can say which.
        if let Some(same_name) = personas.iter().find(|persona| persona.display_name == name) {
            let non_omp = !is_eligible_target(same_name);
            let message = if non_omp {
                format!(
                    "`{name}` is a `{}` agent. It cannot take the `omp` profile; rename it or pick another agent.",
                    same_name.runtime.as_deref().unwrap_or("non-omp")
                )
            } else {
                format!(
                    "Another agent is already named `{name}`. Rename it, or map the profile to an existing agent — adding a second `{name}` agent is not possible."
                )
            };
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Conflict,
                Some(if non_omp {
                    RosterVerdictKind::NameTakenNonOmp
                } else {
                    RosterVerdictKind::NameTaken
                }),
                message,
            );
            entry.persona_id = Some(same_name.id.clone());
            entry.persona_display_name = Some(display_of(same_name));
            entry.expected_digest = Some(digest_of(same_name));
            entries.push(entry);
            continue;
        }

        if !claimants.is_empty() {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Unmapped,
                Some(RosterVerdictKind::UnmappedClaimants),
                format!(
                    concat!(
                        "Could not identify which existing agent owns `{}`. ",
                        "Map an eligible omp agent if possible, or resolve the ",
                        "existing selector assignments before deployment."
                    ),
                    name
                ),
            );
            entry.candidates = claimants
                .iter()
                .filter(|persona| is_eligible_target(persona))
                .map(|persona| candidate(persona))
                .collect();
            entries.push(entry);
            continue;
        }

        // An `omp` persona with no selector and no provenance is a row whose
        // profile cannot be established — the state a legacy roster row reaches
        // when its selector was cleared. It is the only remaining candidate for
        // a profile nothing else claims, so the profile becomes a question
        // rather than minting a duplicate beside it.
        let unaccounted = unaccounted_rows(personas);
        if !unaccounted.is_empty() {
            let mut entry = entry_for(
                declaration,
                RosterVerdict::Unmapped,
                Some(RosterVerdictKind::UnmappedUnaccounted),
                format!(
                    "Could not tell whether {} is the deployed `{name}`. Map an existing agent or create a new agent for this profile.",
                    unaccounted
                        .iter()
                        .map(|persona| format!("`{}`", display_of(persona)))
                        .collect::<Vec<_>>()
                        .join(" or ")
                ),
            );
            entry.candidates = unaccounted.iter().map(|persona| candidate(persona)).collect();
            entries.push(entry);
            continue;
        }

        entries.push(entry_for(
            declaration,
            RosterVerdict::Create,
            None,
            format!("No agent is deployed for `{name}`. Deployment will add it."),
        ));
    }

    // Personas-side observations: selectors the catalogue cannot answer for.
    // Both are display-only and are never repaired.
    let mut not_installed = Vec::new();
    let mut manual_value = Vec::new();
    for persona in personas {
        let Some(selector) = selector_of(persona) else {
            continue;
        };
        let trimmed = selector.trim();
        if trimmed.is_empty() || persona.runtime.as_deref() != Some("omp") {
            continue;
        }
        if declared_names.contains(&trimmed) {
            continue;
        }
        if !valid_profile_name(trimmed) {
            manual_value.push(ManualValueEntry {
                persona_id: persona.id.clone(),
                display_name: display_of(persona),
                selector: trimmed.to_string(),
                message: format!(
                    "`{}` is an omp agent with a malformed profile selector (`{trimmed}`). Pick one, or map it to a profile.",
                    display_of(persona)
                ),
            });
        } else {
            not_installed.push(NotInstalledEntry {
                persona_id: persona.id.clone(),
                display_name: display_of(persona),
                selector: trimmed.to_string(),
                message: format!(
                    "`{}` selects profile `{trimmed}`, which the catalogue does not declare. Effective configuration for this agent cannot be established.",
                    display_of(persona)
                ),
            });
        }
    }

    let teams = super::presets::plan_teams(&entries, teams);

    let mut shared_members = Vec::new();
    let mut seen: Vec<(String, Vec<String>)> = Vec::new();
    for team in &teams {
        for member in &team.members {
            let Some(persona_id) = member.persona_id.as_ref() else {
                continue;
            };
            let display_name = member.display_name.clone().unwrap_or_default();
            match seen.iter_mut().find(|(id, _)| id == persona_id) {
                Some((_, slugs)) => {
                    if !slugs.contains(&team.slug) {
                        slugs.push(team.slug.clone());
                    }
                }
                None => seen.push((persona_id.clone(), vec![team.slug.clone()])),
            }
            let _ = display_name;
        }
    }
    for (persona_id, preset_slugs) in seen {
        if preset_slugs.len() < 2 {
            continue;
        }
        let display_name = personas
            .iter()
            .find(|persona| persona.id == persona_id)
            .map(display_of)
            .unwrap_or_else(|| persona_id.clone());
        shared_members.push(SharedMember {
            persona_id,
            display_name,
            preset_slugs,
        });
    }

    let counts = PlanCounts {
        create: count(&entries, RosterVerdict::Create),
        adopt: count(&entries, RosterVerdict::Adopt),
        unchanged: count(&entries, RosterVerdict::Unchanged),
        diverged: count(&entries, RosterVerdict::Diverged),
        unmapped: count(&entries, RosterVerdict::Unmapped),
        conflict: count(&entries, RosterVerdict::Conflict),
        unavailable: count(&entries, RosterVerdict::Unavailable),
        applyable: count(&entries, RosterVerdict::Create) + count(&entries, RosterVerdict::Adopt),
    };
    // Only a conflict or an unanswered question disables Apply, as the plan
    // specifies. An `unavailable` profile is a fact about the machine, not a
    // decision the user can make, so it must not block the work that IS
    // available. A team blocked solely by an unavailable member is likewise
    // reported, not blocking.
    let apply_blocked = counts.conflict > 0 || counts.unmapped > 0;

    RosterDeployPlan {
        ambient,
        entries,
        not_installed,
        manual_value,
        teams,
        shared_members,
        counts,
        apply_blocked,
    }
}

fn count(entries: &[RosterPlanEntry], verdict: RosterVerdict) -> usize {
    entries
        .iter()
        .filter(|entry| entry.verdict == verdict)
        .count()
}

/// The identity write an `adopt` performs: the immutable provenance field, and
/// the selector only when the row has none (or has the UI's empty "inherit"
/// token). Everything else on the row is left untouched — the caller patches
/// the *current* row rather than round-tripping a preview-era payload.
pub(crate) fn apply_adoption(persona: &mut AgentDefinition, profile: &str, now: &str) {
    if persona
        .env_vars
        .get("OMP_PROFILE")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        persona
            .env_vars
            .insert("OMP_PROFILE".to_string(), profile.to_string());
    }
    persona.deployment_identity = Some(DeploymentIdentity::new(profile, now));
}

pub(crate) fn new_deployed_persona(
    declaration: &OmpProfileCatalogEntry,
    id: String,
    now: &str,
) -> AgentDefinition {
    AgentDefinition {
        id,
        display_name: declaration.name.clone(),
        avatar_url: None,
        description: None,
        system_prompt: String::new(),
        runtime: Some("omp".to_string()),
        model: None,
        provider: None,
        name_pool: Vec::new(),
        is_builtin: false,
        is_active: true,
        shared: false,
        source_team: None,
        source_team_persona_slug: None,
        catalog_source: None,
        team_catalog_source: None,
        deployment_identity: Some(DeploymentIdentity::new(declaration.name.clone(), now)),
        env_vars: std::collections::BTreeMap::from([(
            "OMP_PROFILE".to_string(),
            declaration.name.clone(),
        )]),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

