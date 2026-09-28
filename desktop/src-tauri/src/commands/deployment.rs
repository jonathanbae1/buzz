//! The deployment command surface: a read-only preview, and a narrow apply
//! that revalidates the plan it was handed before writing anything.
//!
//! Split from `commands/personas` (file-size cap) because apply is not a
//! persona mutation: it patches two identity keys on a row it re-reads itself,
//! rather than round-tripping a payload the preview captured. That distinction
//! is the whole point — `update_persona` assigns a whole payload after loading
//! under the lock, so reusing it with preview-era values would overwrite an
//! edit made while the dialog was open (M2 plan, "Apply-time revalidation").

use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    app_state::AppState,
    managed_agents::{
        config_bridge::reader::read_omp_profile_catalog,
        config_bridge::types::OmpProfileState,
        deployment::activation::ActivationGates,
        deployment::presets::{member_ids, new_preset_team, TEAM_PRESETS},
        deployment::roster::{
            apply_adoption, new_deployed_persona, plan_roster_deploy, AdoptVia, ProfileMapping,
            RosterDeployPlan, RosterPlanEntry, RosterVerdict, TeamPresetVerdict,
        },
        ensure_persona_ids_are_active, load_personas, load_teams, save_personas, save_teams,
        TeamRecord,
    },
    util::now_iso,
};

use super::personas::retain_persona_pending;
use super::teams::retain_team_pending;

/// One entry's outcome. Reported per entry, because a failure mid-batch must
/// name exactly which entries landed and which did not.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedEntry {
    pub name: String,
    /// What apply did: `created`, `adopted`, `teamCreated`, or a refusal verb.
    pub outcome: String,
    /// Why it was refused, when it was.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRosterDeployResult {
    /// The plan as it stood before apply — the one the user accepted.
    pub applied: Vec<AppliedEntry>,
    /// A freshly recomputed plan. The UI shows this when the plan was stale,
    /// so the user reviews the new state instead of a partial success.
    pub refreshed: RosterDeployPlan,
    /// True when at least one entry was refused for staleness.
    pub stale: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyRosterDeployRequest {
    /// The preview the user accepted, verbatim. Its `expectedDigest` values are
    /// the revalidation basis and its `adopt` entries with `via: userMap` are
    /// the user's mappings.
    pub plan: RosterDeployPlan,
}

/// Read the catalogue and refuse to plan against a broken one.
fn configured_declarations() -> Result<
    Vec<crate::managed_agents::config_bridge::types::OmpProfileCatalogEntry>,
    String,
> {
    let catalog = read_omp_profile_catalog();
    if catalog.state != OmpProfileState::Configured {
        return Err(match catalog.state {
            OmpProfileState::Invalid => {
                "the installed omp profile catalogue is invalid; repair it before deploying".to_string()
            }
            _ => "the installed omp profile catalogue is unavailable".to_string(),
        });
    }
    Ok(catalog.entries)
}

/// Recompute the plan from current store state. Both the preview and apply use
/// this, so "the pane renders the plan and the handler executes the same plan
/// object" holds by construction rather than by discipline.
fn recompute(
    app: &AppHandle,
    submissions: Option<&RosterDeployPlan>,
) -> Result<(RosterDeployPlan, Vec<crate::managed_agents::AgentDefinition>, Vec<TeamRecord>), String> {
    let declarations = configured_declarations()?;
    let gates = ActivationGates::load();
    let personas = load_personas(app)?;
    let teams = load_teams(app)?;

    // The user's answers ride on the submitted plan: an `adopt` with
    // `via: userMap` IS the mapping. Recomputing with them is what makes the
    // revalidation a recompute rather than a field-by-field diff.
    let mappings: Vec<ProfileMapping> = submissions
        .map(|plan| {
            plan.entries
                .iter()
                .filter(|entry| {
                    entry.verdict == RosterVerdict::Adopt && entry.via == Some(AdoptVia::UserMap)
                })
                .filter_map(|entry| {
                    entry.persona_id.as_ref().map(|persona_id| ProfileMapping {
                        name: entry.name.clone(),
                        persona_id: persona_id.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let plan = plan_roster_deploy(&declarations, &personas, &teams, &gates, &mappings);
    Ok((plan, personas, teams))
}

/// Read-only: what a deploy would do right now. Writes nothing.
#[tauri::command]
pub async fn preview_roster_deploy(
    app: AppHandle,
) -> Result<RosterDeployPlan, String> {
    tokio::task::spawn_blocking(move || recompute(&app, None).map(|(plan, _, _)| plan))
        .await
        .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

/// Read-only: the preset declarations, so the UI never carries a second copy of
/// the member list.
#[tauri::command]
pub fn list_team_presets() -> Vec<serde_json::Value> {
    TEAM_PRESETS
        .iter()
        .map(|preset| {
            serde_json::json!({
                "slug": preset.slug,
                "name": preset.name,
                "description": preset.description,
                "members": preset.members,
            })
        })
        .collect()
}

/// Compare a submitted entry against its recomputed counterpart.
///
/// Returns `Ok(())` when the entry may be applied, or `Err(reason)` naming what
/// moved. Every input that could have changed — the verdict, the adoption
/// route, the target row, and that row's content hash — is compared, because
/// any one of them changing means the user is no longer looking at the state
/// apply would write to.
fn admit(submitted: &RosterPlanEntry, current: &RosterPlanEntry) -> Result<(), String> {
    if submitted.verdict != current.verdict {
        return Err(format!(
            "the entry is no longer `{}` (it is now `{}`)",
            verb(submitted.verdict),
            verb(current.verdict)
        ));
    }
    if submitted.via != current.via {
        return Err("the adoption route changed".to_string());
    }
    if submitted.persona_id != current.persona_id {
        return Err("the agent this entry targets changed".to_string());
    }
    if submitted.expected_digest != current.expected_digest {
        return Err("this agent changed while you were looking".to_string());
    }
    Ok(())
}

fn verb(verdict: RosterVerdict) -> &'static str {
    match verdict {
        RosterVerdict::Create => "create",
        RosterVerdict::Adopt => "adopt",
        RosterVerdict::Unchanged => "unchanged",
        RosterVerdict::Diverged => "diverged",
        RosterVerdict::Unmapped => "unmapped",
        RosterVerdict::Conflict => "conflict",
        RosterVerdict::Unavailable => "unavailable",
    }
}

/// Apply an accepted plan.
///
/// * Re-acquires the store lock, re-reads the current rows, and recomputes the
///   plan. Any entry whose digest moved is **refused**, not applied.
/// * Writes only the identity keys of the target row and leaves every other
///   field of the *current* row untouched — it never round-trips a payload.
/// * Applies entries one at a time in plan order. A failure mid-batch reports
///   which entries landed and which did not; the refreshed plan shows the
///   remainder, so retry is the recovery path. Nothing is rolled back — each
///   created row is individually valid.
#[tauri::command]
pub async fn apply_roster_deploy(
    input: ApplyRosterDeployRequest,
    app: AppHandle,
) -> Result<ApplyRosterDeployResult, String> {
    use tauri::Manager;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let submitted = input.plan;
        let mut applied: Vec<AppliedEntry> = Vec::new();
        let mut stale = false;

        // Read the catalogue before taking the lock: it is installer-owned and
        // independent of the store, and holding the lock through a file read
        // would serialise behind unrelated writers for no benefit.
        let declarations = configured_declarations()?;
        let gates = ActivationGates::load();

        let now = now_iso();

        let _store_guard = state
            .managed_agents_store_lock
            .lock()
            .map_err(|error| error.to_string())?;

        let mut personas = load_personas(&app)?;
        let mut teams = load_teams(&app)?;
        let mappings: Vec<ProfileMapping> = submitted
            .entries
            .iter()
            .filter(|entry| {
                entry.verdict == RosterVerdict::Adopt && entry.via == Some(AdoptVia::UserMap)
            })
            .filter_map(|entry| {
                entry.persona_id.as_ref().map(|persona_id| ProfileMapping {
                    name: entry.name.clone(),
                    persona_id: persona_id.clone(),
                })
            })
            .collect();
        let current = plan_roster_deploy(&declarations, &personas, &teams, &gates, &mappings);

        // ── Personas ─────────────────────────────────────────────────────────
        for submitted_entry in &submitted.entries {
            let Some(current_entry) = current
                .entries
                .iter()
                .find(|entry| entry.name == submitted_entry.name)
            else {
                stale = true;
                applied.push(AppliedEntry {
                    name: submitted_entry.name.clone(),
                    outcome: "refused".to_string(),
                    reason: Some("the catalogue no longer declares this profile".to_string()),
                });
                continue;
            };

            match submitted_entry.verdict {
                RosterVerdict::Create => {
                    if let Err(reason) = admit(submitted_entry, current_entry) {
                        stale = true;
                        applied.push(AppliedEntry {
                            name: submitted_entry.name.clone(),
                            outcome: "refused".to_string(),
                            reason: Some(reason),
                        });
                        continue;
                    }
                    let persona = new_deployed_persona(
                        &crate::managed_agents::config_bridge::types::OmpProfileCatalogEntry {
                            name: submitted_entry.name.clone(),
                            model_lane: submitted_entry.model_lane.clone(),
                            rule_paths: submitted_entry.rule_paths.clone(),
                            plugin_names: submitted_entry.plugin_names.clone(),
                        },
                        Uuid::new_v4().to_string(),
                        &now,
                    );
                    personas.push(persona.clone());
                    match save_personas(&app, &personas) {
                        Ok(()) => {
                            retain_persona_pending(&app, &state, &persona);
                            applied.push(AppliedEntry {
                                name: submitted_entry.name.clone(),
                                outcome: "created".to_string(),
                                reason: None,
                            });
                        }
                        Err(error) => {
                            // The row never landed; drop it from the in-memory
                            // list so a later entry's save cannot write a
                            // persona that was reported as failed.
                            personas.retain(|candidate| candidate.id != persona.id);
                            applied.push(AppliedEntry {
                                name: submitted_entry.name.clone(),
                                outcome: "failed".to_string(),
                                reason: Some(error),
                            });
                        }
                    }
                }
                RosterVerdict::Adopt => {
                    if let Err(reason) = admit(submitted_entry, current_entry) {
                        stale = true;
                        applied.push(AppliedEntry {
                            name: submitted_entry.name.clone(),
                            outcome: "refused".to_string(),
                            reason: Some(reason),
                        });
                        continue;
                    }
                    let Some(persona_id) = current_entry.persona_id.clone() else {
                        stale = true;
                        applied.push(AppliedEntry {
                            name: submitted_entry.name.clone(),
                            outcome: "refused".to_string(),
                            reason: Some("the adoption target is gone".to_string()),
                        });
                        continue;
                    };
                    let Some(persona) = personas
                        .iter_mut()
                        .find(|persona| persona.id == persona_id)
                    else {
                        stale = true;
                        applied.push(AppliedEntry {
                            name: submitted_entry.name.clone(),
                            outcome: "refused".to_string(),
                            reason: Some("the adoption target is gone".to_string()),
                        });
                        continue;
                    };
                    // Only the identity keys move: provenance, and the selector
                    // when the row has none. Everything else on the current row
                    // is left byte-identical.
                    apply_adoption(persona, &submitted_entry.name, &now);
                    persona.updated_at = now.clone();
                    let snapshot = persona.clone();
                    match save_personas(&app, &personas) {
                        Ok(()) => {
                            retain_persona_pending(&app, &state, &snapshot);
                            applied.push(AppliedEntry {
                                name: submitted_entry.name.clone(),
                                outcome: "adopted".to_string(),
                                reason: None,
                            });
                        }
                        Err(error) => {
                            applied.push(AppliedEntry {
                                name: submitted_entry.name.clone(),
                                outcome: "failed".to_string(),
                                reason: Some(error),
                            });
                        }
                    }
                }
                // `unchanged` writes nothing by definition; the rest are not
                // actions. Reporting them keeps the response a complete account
                // of the submitted plan.
                _ => {}
            }
        }

        // ── Preset teams ─────────────────────────────────────────────────────
        //
        // Teams are created after the personas, because a preset's members are
        // personas this same apply may have just created. Members are resolved
        // from a plan recomputed over the *post-persona* store, so a member
        // created moments ago has an id to bind.
        let mid = plan_roster_deploy(&declarations, &personas, &teams, &gates, &mappings);
        for submitted_team in &submitted.teams {
            if submitted_team.verdict != TeamPresetVerdict::Create {
                continue;
            }
            let Some(preset) = TEAM_PRESETS
                .iter()
                .find(|preset| preset.slug == submitted_team.slug)
            else {
                stale = true;
                applied.push(AppliedEntry {
                    name: submitted_team.slug.clone(),
                    outcome: "refused".to_string(),
                    reason: Some("this build does not declare that preset".to_string()),
                });
                continue;
            };
            let persona_ids = member_ids(preset, &mid.entries);
            if persona_ids.len() != preset.members.len() {
                applied.push(AppliedEntry {
                    name: submitted_team.slug.clone(),
                    outcome: "blocked".to_string(),
                    reason: Some(
                        "a member profile did not resolve, so the team was not partially created"
                            .to_string(),
                    ),
                });
                // A blocked preset is a reported non-action, not staleness.
                continue;
            }
            if let Err(error) = ensure_persona_ids_are_active(&personas, &persona_ids) {
                applied.push(AppliedEntry {
                    name: submitted_team.slug.clone(),
                    outcome: "blocked".to_string(),
                    reason: Some(error),
                });
                continue;
            }
            let team = new_preset_team(
                preset,
                Uuid::new_v4().to_string(),
                persona_ids,
                &now,
            );
            teams.push(team.clone());
            match save_teams(&app, &teams) {
                Ok(()) => {
                    retain_team_pending(&app, &state, &team);
                    applied.push(AppliedEntry {
                        name: submitted_team.slug.clone(),
                        outcome: "teamCreated".to_string(),
                        reason: None,
                    });
                }
                Err(error) => {
                    teams.retain(|candidate| candidate.id != team.id);
                    applied.push(AppliedEntry {
                        name: submitted_team.slug.clone(),
                        outcome: "failed".to_string(),
                        reason: Some(error),
                    });
                }
            }
        }

        let refreshed = plan_roster_deploy(&declarations, &personas, &teams, &gates, &mappings);
        Ok(ApplyRosterDeployResult {
            applied,
            refreshed,
            stale,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking failed: {e}"))?
}

