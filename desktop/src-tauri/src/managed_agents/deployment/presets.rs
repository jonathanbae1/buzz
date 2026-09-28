//! Deployment presets: the first-party teams the roster deploy can create.
//!
//! A preset is identified by a **slug**, not its display name, and carries
//! `(slug, version)` provenance on the team it created. That is the analogue of
//! the foreign-catalog `catalog_source`, and it is what makes a second deploy
//! idempotent: the copy carries a fresh local id, so nothing else can answer
//! "is this preset already deployed".
//!
//! Not `is_builtin`: built-ins are auto-seeded on load by id, whereas a preset
//! is opt-in and must not appear in a store the user never deployed.
//!
//! Studio: only the *team record* is reconciled here. Creating one agent per
//! member in a channel is the existing `AddTeamToChannelDialog` flow and is
//! deliberately outside the idempotency contract.

use crate::managed_agents::{TeamRecord, TeamPresetSource};

use super::roster::{
    preset_content_digest, team_content_digest, RosterPlanEntry, TeamMemberResolution,
    TeamPlanEntry, TeamPresetVerdict,
};

/// Preset version. Bumped when the members list changes, so a stored copy built
/// from an older version reconciles as `edited` rather than silently matching.
pub(crate) const PRESET_VERSION: &str = "1";

pub(crate) const BUILD_SLUG: &str = "build";
pub(crate) const DESIGN_REVIEW_SLUG: &str = "design-review";

#[derive(Debug, Clone, Copy)]
pub struct TeamPreset {
    pub slug: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Member profiles, in display order. Profiles, not persona ids — a preset
    /// ships with the installer, and persona ids are minted per machine.
    pub members: &'static [&'static str],
}

pub(crate) const TEAM_PRESETS: &[TeamPreset] = &[
    TeamPreset {
        slug: BUILD_SLUG,
        name: "Build",
        description: "Implementation, review and reconnaissance for shipping work.",
        members: &["coder", "reviewer", "scout"],
    },
    TeamPreset {
        slug: DESIGN_REVIEW_SLUG,
        name: "Design review",
        description: "Bursty design and image review on the Google bucket.",
        members: &["designer", "reviewer"],
    },
];

/// Resolve one member profile to a persona id from the roster plan.
///
/// Members are resolved *before* the team exists, so a team with any
/// unresolvable member is `blocked` and is never partially created.
fn resolve_member(profile: &str, entries: &[RosterPlanEntry]) -> TeamMemberResolution {
    let entry = entries.iter().find(|entry| entry.name == profile);
    let Some(entry) = entry else {
        return TeamMemberResolution {
            profile: profile.to_string(),
            persona_id: None,
            display_name: None,
            message: format!("The catalogue does not declare a `{profile}` profile."),
        };
    };
    match entry.verdict {
        super::roster::RosterVerdict::Create => TeamMemberResolution {
            profile: profile.to_string(),
            // No id yet: the roster deploy creates it in the same apply, and
            // the team is created afterwards from a plan recomputed over the
            // post-persona store (see `member_ids`).
            persona_id: None,
            display_name: Some(entry.name.clone()),
            message: format!("`{profile}` is created by this deploy."),
        },
        super::roster::RosterVerdict::Adopt => TeamMemberResolution {
            profile: profile.to_string(),
            persona_id: entry.persona_id.clone(),
            display_name: entry.persona_display_name.clone(),
            message: format!("`{profile}` is adopted by this deploy."),
        },
        super::roster::RosterVerdict::Unchanged | super::roster::RosterVerdict::Diverged => {
            TeamMemberResolution {
                profile: profile.to_string(),
                persona_id: entry.persona_id.clone(),
                display_name: entry.persona_display_name.clone(),
                message: format!("`{profile}` is already deployed."),
            }
        }
        super::roster::RosterVerdict::Unavailable => TeamMemberResolution {
            profile: profile.to_string(),
            persona_id: None,
            display_name: None,
            message: entry.detail.clone().unwrap_or_else(|| {
                format!("`{profile}` cannot be deployed on this machine yet.")
            }),
        },
        super::roster::RosterVerdict::Unmapped => TeamMemberResolution {
            profile: profile.to_string(),
            persona_id: None,
            display_name: None,
            message: format!(
                "`{profile}` needs a user mapping before the preset can be created."
            ),
        },
        super::roster::RosterVerdict::Conflict => TeamMemberResolution {
            profile: profile.to_string(),
            persona_id: None,
            display_name: None,
            message: format!("`{profile}` has a conflict that must be resolved first."),
        },
    }
}

/// Plan every preset against the current store.
pub(crate) fn plan_teams(entries: &[RosterPlanEntry], teams: &[TeamRecord]) -> Vec<TeamPlanEntry> {
    TEAM_PRESETS
        .iter()
        .map(|preset| {
            let members: Vec<TeamMemberResolution> = preset
                .members
                .iter()
                .map(|profile| resolve_member(profile, entries))
                .collect();
            let member_profiles: Vec<String> =
                preset.members.iter().map(|s| s.to_string()).collect();

            // Existing team for this slug. By slug, the way built-ins reconcile
            // by id — never by display name.
            let existing = teams.iter().find(|team| {
                team.preset_source
                    .as_ref()
                    .is_some_and(|source| source.slug == preset.slug)
            });

            // Blocked first: an unresolvable member is a fact about the roster,
            // not about any existing team. A `Create` member is resolvable —
            // the same apply creates it — so only a member whose entry cannot
            // yield a persona blocks the preset.
            let blocker = members.iter().find(|member| {
                member.persona_id.is_none()
                    && !matches!(
                        entries
                            .iter()
                            .find(|entry| entry.name == member.profile)
                            .map(|entry| entry.verdict),
                        Some(super::roster::RosterVerdict::Create)
                    )
            });

            if let Some(blocker) = blocker {
                let blocker_message = blocker.message.clone();
                return TeamPlanEntry {
                    slug: preset.slug.to_string(),
                    name: preset.name.to_string(),
                    version: PRESET_VERSION.to_string(),
                    verdict: TeamPresetVerdict::Blocked,
                    team_id: existing.map(|team| team.id.clone()),
                    members,
                    message: format!(
                        "`{}` is not deployable yet: {blocker_message}",
                        preset.name
                    ),
                    expected_digest: existing.map(team_content_digest),
                    member_profiles,
                };
            }

            let Some(team) = existing else {
                return TeamPlanEntry {
                    slug: preset.slug.to_string(),
                    name: preset.name.to_string(),
                    version: PRESET_VERSION.to_string(),
                    verdict: TeamPresetVerdict::Create,
                    team_id: None,
                    members,
                    message: format!("No team carries the `{}` preset. Deployment will add it.", preset.name),
                    expected_digest: None,
                    member_profiles,
                };
            };

            // Membership is a digest input, so an edit the user made wins: a
            // removed member stays removed and reads as `edited`, never as a
            // silent re-add.
            let stored = team_content_digest(team);
            let version_matches = team
                .preset_source
                .as_ref()
                .is_some_and(|source| source.version == PRESET_VERSION);
            let expected_members: Vec<&String> = members
                .iter()
                .filter_map(|member| member.persona_id.as_ref())
                .collect();
            let membership_matches = expected_members.len() == team.persona_ids.len()
                && expected_members
                    .iter()
                    .all(|id| team.persona_ids.contains(id));

            let pristine = version_matches
                && membership_matches
                && team.name == preset.name
                && team.description.as_deref() == Some(preset.description)
                && team.instructions.is_none()
                && stored
                    == preset_content_digest(
                        preset.name,
                        Some(preset.description),
                        &team.persona_ids,
                    );

            if pristine {
                return TeamPlanEntry {
                    slug: preset.slug.to_string(),
                    name: preset.name.to_string(),
                    version: PRESET_VERSION.to_string(),
                    verdict: TeamPresetVerdict::Unchanged,
                    team_id: Some(team.id.clone()),
                    members,
                    message: format!("`{}` is already deployed and unchanged. Nothing is written.", preset.name),
                    expected_digest: Some(stored),
                    member_profiles,
                };
            }

            TeamPlanEntry {
                slug: preset.slug.to_string(),
                name: preset.name.to_string(),
                version: PRESET_VERSION.to_string(),
                verdict: TeamPresetVerdict::Edited,
                team_id: Some(team.id.clone()),
                members,
                message: format!(
                    "`{}` was edited after deployment. Your name, description, instructions and membership are preserved verbatim.",
                    preset.name
                ),
                expected_digest: Some(stored),
                member_profiles,
            }
        })
        .collect()
}

/// The team record a preset deploy creates. Identity is `(slug, version)`; a
/// fresh local id keeps it distinct from every other team.
pub(crate) fn new_preset_team(
    preset: &TeamPreset,
    id: String,
    persona_ids: Vec<String>,
    now: &str,
) -> TeamRecord {
    TeamRecord {
        id,
        name: preset.name.to_string(),
        description: Some(preset.description.to_string()),
        instructions: None,
        persona_ids,
        is_builtin: false,
        // View projection only — `list_teams` recomputes it from the scoped
        // 30178 head. A local preset has no catalog head.
        shared: false,
        catalog_source: None,
        // Preset provenance is set only by preset deployment, never by an
        // ordinary create.
        preset_source: Some(TeamPresetSource::new(preset.slug, PRESET_VERSION)),
        source_dir: None,
        is_symlink: false,
        symlink_target: None,
        version: Some(PRESET_VERSION.to_string()),
        created_at: now.to_string(),
        updated_at: now.to_string(),
    }
}

/// Compose the member-id list for a preset, preserving the preset's declared
/// order.
///
/// Members are resolved from the plan's own entries — the same binding rule the
/// roster uses — rather than from the submitted preview, because a member the
/// same apply just created has no id in the preview. Resolving against current
/// state is what lets a preset be created in the same pass as its personas.
pub(crate) fn member_ids(preset: &TeamPreset, entries: &[RosterPlanEntry]) -> Vec<String> {
    preset
        .members
        .iter()
        .filter_map(|profile| {
            entries
                .iter()
                .find(|entry| entry.name == *profile)
                .and_then(|entry| entry.persona_id.clone())
        })
        .collect()
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_are_slug_and_versioned() {
        for preset in TEAM_PRESETS {
            let team = new_preset_team(preset, "id-1".to_string(), vec!["p1".into()], "now");
            let source = team.preset_source.expect("preset provenance");
            assert_eq!(source.slug, preset.slug);
            assert_eq!(source.version, PRESET_VERSION);
            assert!(!team.is_builtin, "a preset is not a built-in");
        }
    }

    #[test]
    fn member_ids_follow_the_preset_order_not_the_resolution_order() {
        let preset = TEAM_PRESETS
            .iter()
            .find(|preset| preset.slug == BUILD_SLUG)
            .unwrap();
        // Deliberately out of order: the id list must follow the preset's
        // declared order, not the order entries happen to sit in the plan.
        let entries = vec![
            roster_entry("scout", Some("p-scout")),
            roster_entry("coder", Some("p-coder")),
            roster_entry("reviewer", Some("p-reviewer")),
        ];
        assert_eq!(
            member_ids(preset, &entries),
            vec!["p-coder", "p-reviewer", "p-scout"]
        );
        // A member with no id (still to be created) simply does not contribute,
        // which is what makes the caller's length check meaningful.
        let partial = vec![roster_entry("coder", Some("p-coder"))];
        assert_eq!(member_ids(preset, &partial), vec!["p-coder"]);
    }

    /// Minimal plan entry — only the two fields `member_ids` reads.
    fn roster_entry(name: &str, persona_id: Option<&str>) -> RosterPlanEntry {
        RosterPlanEntry {
            name: name.to_string(),
            verdict: crate::managed_agents::deployment::roster::RosterVerdict::Unchanged,
            kind: None,
            via: None,
            persona_id: persona_id.map(str::to_string),
            persona_display_name: None,
            current_selector: None,
            message: String::new(),
            detail: None,
            candidates: Vec::new(),
            rule_paths: Vec::new(),
            plugin_names: Vec::new(),
            model_lane: String::new(),
            expected_digest: None,
        }
    }
}
