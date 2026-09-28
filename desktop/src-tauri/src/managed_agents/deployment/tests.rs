//! Acceptance tests for the roster deploy plan (M2 gates G0 and G1).
//!
//! Every test drives the real `plan_roster_deploy` over fixture stores shaped
//! like the ones the installed app writes — including the five real roster rows
//! transcribed from the live store (provenance-less, selector present). Nothing
//! here reimplements the predicate; that is the point of the plan being a pure
//! function.

use std::collections::BTreeMap;

use crate::managed_agents::config_bridge::types::OmpProfileCatalogEntry;
use crate::managed_agents::deployment::activation::{proof_record, ActivationGates};
use crate::managed_agents::deployment::presets::TEAM_PRESETS;
use crate::managed_agents::{
    deployment::presets::plan_teams, deployment::roster::*, AgentDefinition, DeploymentIdentity,
    TeamRecord,
};

const LANE: &str = "anthropic/claude-opus-5-5:high";

fn declaration(name: &str) -> OmpProfileCatalogEntry {
    OmpProfileCatalogEntry {
        name: name.to_string(),
        model_lane: LANE.to_string(),
        rule_paths: vec![
            "profiles/rules/global.md".to_string(),
            format!("profiles/roles/{name}.md"),
        ],
        plugin_names: vec!["example-plugin@marketplace".to_string()],
    }
}

/// The seven-entry catalogue the installer currently emits: `default` plus six
/// roles. `curator` is deliberately absent — it is a task agent, not a profile
/// (the recall slice's decision), so it must never appear as a roster entry.
fn catalogue() -> Vec<OmpProfileCatalogEntry> {
    [
        "default",
        "orchestrator",
        "planner",
        "coder",
        "reviewer",
        "scout",
        "designer",
    ]
    .iter()
    .map(|name| declaration(name))
    .collect()
}

fn persona(
    id: &str,
    display: &str,
    runtime: Option<&str>,
    selector: Option<&str>,
) -> AgentDefinition {
    AgentDefinition {
        id: id.to_string(),
        display_name: display.to_string(),
        avatar_url: None,
        description: None,
        system_prompt: String::new(),
        runtime: runtime.map(str::to_string),
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
        deployment_identity: None,
        env_vars: selector
            .map(|value| BTreeMap::from([("OMP_PROFILE".to_string(), value.to_string())]))
            .unwrap_or_default(),
        respond_to: None,
        respond_to_allowlist: Vec::new(),
        parallelism: None,
        created_at: "2026-09-01T00:00:00Z".to_string(),
        updated_at: "2026-09-01T00:00:00Z".to_string(),
    }
}

fn deployed(id: &str, display: &str, profile: &str, selector: Option<&str>) -> AgentDefinition {
    let mut row = persona(id, display, Some("omp"), selector);
    row.deployment_identity = Some(DeploymentIdentity::new(profile, "2026-09-20T00:00:00Z"));
    row
}

/// The five real roster rows, exactly as the installed store carries them: an
/// `omp` runtime, a selector matching the display name, and **no** provenance
/// (the pre-M2 roster wrote none).
fn installed_roster() -> Vec<AgentDefinition> {
    vec![
        persona("2726b5be", "coder", Some("omp"), Some("coder")),
        persona(
            "4d5caf55",
            "orchestrator",
            Some("omp"),
            Some("orchestrator"),
        ),
        persona("705670a5", "reviewer", Some("omp"), Some("reviewer")),
        persona("ad0cc4d2", "scout", Some("omp"), Some("scout")),
        persona("f1465360", "planner", Some("omp"), Some("planner")),
    ]
}

/// The machine's proof record, in the shape a passing G4 would write: every
/// profile except the gated one, proved against the omp version under test.
fn gates() -> ActivationGates {
    gates_except(&["designer"])
}

fn gates_except(gated: &[&str]) -> ActivationGates {
    let proofs = catalogue()
        .iter()
        .filter(|declaration| !gated.contains(&declaration.name.as_str()))
        .map(|declaration| {
            proof_record(
                &declaration.name,
                OMP_UNDER_TEST,
                "2026-09-28T00:00:00Z",
                "fixture",
            )
        })
        .collect();
    ActivationGates::from_parts(
        std::path::PathBuf::from("/tmp/fixture/proofs.json"),
        Ok(proofs),
        Some(OMP_UNDER_TEST.to_string()),
    )
}

const OMP_UNDER_TEST: &str = "18.3.5";

fn plan(personas: &[AgentDefinition]) -> RosterDeployPlan {
    plan_roster_deploy(&catalogue(), personas, &[], &gates(), &[])
}

fn entry<'a>(plan: &'a RosterDeployPlan, name: &str) -> &'a RosterPlanEntry {
    plan.entries
        .iter()
        .find(|entry| entry.name == name)
        .unwrap_or_else(|| panic!("no plan entry for `{name}`"))
}

// ── G0(a) baseline: nothing to create ────────────────────────────────────────

/// A plan over the already-deployed roster creates nothing. This is the
/// "deploy twice → same count" case, asserted against the plan rather than a
/// click.
#[test]
fn g0a_baseline_creates_nothing() {
    let plan = plan(&installed_roster());
    assert_eq!(
        plan.counts.create, 0,
        "a second deploy must not create anything"
    );
    // All five real rows are recognized. They carry no provenance, but each is
    // the single unambiguous holder of its profile with no name conflict, so
    // provenance migration adopts them rather than minting duplicates.
    assert_eq!(plan.counts.adopt, 5, "{:?}", plan.counts);
    assert_eq!(entry(&plan, "coder").verdict, RosterVerdict::Adopt);
    assert_eq!(entry(&plan, "coder").via, Some(AdoptVia::Provenance));
    // `default` is the ambient fallback, not a role. It is derived from the
    // catalogue name, never from a UI literal, and is never a create.
    assert_eq!(plan.ambient.as_deref(), Some("default"));
    assert_eq!(entry(&plan, "default").verdict, RosterVerdict::Unchanged);
    assert_eq!(plan.counts.unchanged, 1);
    // The gated profile is reported, never silently created.
    assert_eq!(entry(&plan, "designer").verdict, RosterVerdict::Unavailable);
    assert!(!plan.apply_blocked);
}

/// `curator` is a task agent, not a profile: it must have no roster entry and
/// must not be derived from any Buzz-side literal.
#[test]
fn roster_entries_are_exactly_the_catalogue() {
    let plan = plan(&installed_roster());
    let names: Vec<&str> = plan
        .entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    assert_eq!(
        names,
        vec![
            "default",
            "orchestrator",
            "planner",
            "coder",
            "reviewer",
            "scout",
            "designer"
        ]
    );
    assert!(!names.contains(&"curator"));
}

// ── G0(b) a deleted definition is one create ─────────────────────────────────

#[test]
fn g0b_deleted_definition_is_one_create() {
    let mut personas = installed_roster();
    personas.retain(|row| row.display_name != "coder");
    let plan = plan(&personas);
    assert_eq!(plan.counts.create, 1);
    assert_eq!(entry(&plan, "coder").verdict, RosterVerdict::Create);
    assert_eq!(plan.counts.adopt, 4);
}

// ── G0(c) an erased legacy identity is a question, never an automatic adopt ──

/// The corrected fail-before case: a legacy row renamed **and** with its
/// selector cleared has no unambiguous mapping, so nothing may claim it.
#[test]
fn g0c_renamed_legacy_row_with_erased_selector_is_unmapped() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "coder" {
            row.display_name = "my coder".to_string();
            row.env_vars.clear();
        }
    }
    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Unmapped, "{coder:?}");
    assert_eq!(
        plan.counts.create, 0,
        "nothing may be created while a question is open"
    );
    assert_eq!(
        coder.candidates.len(),
        1,
        "the erased row is offered as a candidate"
    );
    assert_eq!(coder.candidates[0].display_name, "my coder");
    // Apply is refused while the question is unanswered.
    assert!(plan.apply_blocked);
}

/// A row renamed *without* clearing its selector is still the unambiguous
/// holder: renaming is a legitimate edit and the rename survives a redeploy.
#[test]
fn renamed_row_keeping_its_selector_is_adopted_not_recreated() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "coder" {
            row.display_name = "my coder".to_string();
        }
    }
    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Adopt);
    assert_eq!(coder.via, Some(AdoptVia::Provenance));
    assert_eq!(coder.persona_display_name.as_deref(), Some("my coder"));
    assert_eq!(plan.counts.create, 0);
}

// ── G0(d) a name-only match is always a conflict ──────────────────────────────

#[test]
fn g0d_name_only_match_on_an_omp_persona_is_name_taken() {
    // A fresh fixture with `coder` unclaimed: the real row is gone and an
    // unrelated omp persona merely carries the name.
    let mut personas = installed_roster();
    personas.retain(|row| row.display_name != "coder");
    personas.push(persona("unrelated", "coder", Some("omp"), None));

    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Conflict);
    assert_eq!(coder.kind, Some(RosterVerdictKind::NameTaken));
    assert_eq!(
        plan.counts.create, 0,
        "a name conflict must never be created past"
    );
    assert!(plan.apply_blocked);
}

#[test]
fn g0d_name_only_match_on_a_non_omp_persona_names_the_runtime() {
    let mut personas = installed_roster();
    personas.retain(|row| row.display_name != "coder");
    personas.push(persona("claude-coder", "coder", Some("claude"), None));

    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Conflict);
    assert_eq!(coder.kind, Some(RosterVerdictKind::NameTakenNonOmp));
    assert!(coder.message.contains("claude"), "{}", coder.message);
    assert!(plan.apply_blocked);
}

/// A same-named row is a conflict even when it is the sole holder of the
/// profile — the ambiguity the plan's conflict table forbids resolving by name.
#[test]
fn a_name_match_never_adopts_even_when_it_holds_the_selector() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "scout" {
            row.env_vars.clear();
        }
    }
    personas.push(persona("imposter", "scout", Some("omp"), Some("scout")));

    let plan = plan(&personas);
    let scout = entry(&plan, "scout");
    // `imposter` holds the selector but is also named `scout`, so the name
    // conflict fires first — a name-only match never adopts.
    assert_eq!(scout.verdict, RosterVerdict::Conflict);
    assert_eq!(scout.kind, Some(RosterVerdictKind::NameTaken));
    assert_eq!(
        plan.counts.create, 0,
        "a name-only match must never be created past"
    );
    assert!(plan.apply_blocked);
}

// ── G0(e) a diverged row is reported, never repaired ─────────────────────────

#[test]
fn g0e_deployed_row_with_a_cleared_selector_is_diverged_cleared() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "reviewer" {
            row.deployment_identity =
                Some(DeploymentIdentity::new("reviewer", "2026-09-20T00:00:00Z"));
            row.env_vars.clear();
        }
    }
    let plan = plan(&personas);
    let reviewer = entry(&plan, "reviewer");
    assert_eq!(reviewer.verdict, RosterVerdict::Diverged, "{reviewer:?}");
    assert_eq!(reviewer.kind, Some(RosterVerdictKind::DivergedCleared));
    // Apply stays enabled: a divergence is a report, not a blocker.
    assert!(!plan.apply_blocked);
    // The selector is emphatically not queued for repair: the entry is
    // `diverged`, which is not an action verdict, and its target is the
    // existing row so no `create` can mint a duplicate.
    assert!(
        !matches!(
            reviewer.verdict,
            RosterVerdict::Create | RosterVerdict::Adopt
        ),
        "a diverged row must not be an action"
    );
    assert_eq!(reviewer.persona_id.as_deref(), Some("705670a5"));
    assert_eq!(plan.counts.create, 0);
}

#[test]
fn g0e_deployed_row_reassigned_to_another_profile_is_diverged_reassigned() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "reviewer" {
            row.deployment_identity =
                Some(DeploymentIdentity::new("reviewer", "2026-09-20T00:00:00Z"));
            row.env_vars = BTreeMap::from([("OMP_PROFILE".to_string(), "scout".to_string())]);
        }
        if row.display_name == "scout" {
            // Remove the real scout so the reassigned selector is the sole holder.
            row.env_vars.clear();
            row.display_name = "scout-2".to_string();
        }
    }
    let plan = plan(&personas);
    let reviewer = entry(&plan, "reviewer");
    assert_eq!(reviewer.verdict, RosterVerdict::Diverged);
    assert_eq!(reviewer.kind, Some(RosterVerdictKind::DivergedReassigned));
    assert_eq!(reviewer.current_selector.as_deref(), Some("scout"));
    assert!(
        reviewer.message.contains("Left as is"),
        "{}",
        reviewer.message
    );
    // `scout` is not minted beside the reassigned row: the selector is taken,
    // so a create would fail the duplicate-selector check at save time.
    assert_eq!(plan.counts.create, 0, "{:?}", plan.counts);
    let scout = entry(&plan, "scout");
    assert_eq!(scout.verdict, RosterVerdict::Unchanged);
    assert_eq!(scout.persona_display_name.as_deref(), Some("reviewer"));
}

// ── G1 provenance migration ──────────────────────────────────────────────────

/// Migration maps the five real rows, and the adopt patch is byte-identical
/// everywhere except the identity field and `updated_at`.
#[test]
fn g1_migration_maps_the_five_real_rows_and_patches_only_identity() {
    let personas = installed_roster();
    let plan = plan(&personas);
    let adopts: Vec<&RosterPlanEntry> = plan
        .entries
        .iter()
        .filter(|entry| entry.verdict == RosterVerdict::Adopt)
        .collect();
    assert_eq!(
        adopts.len(),
        5,
        "all five legacy rows must be adopted, not re-created"
    );

    for adopt in &adopts {
        let mut before = personas
            .iter()
            .find(|row| row.id == adopt.persona_id.clone().unwrap())
            .unwrap()
            .clone();
        // What the store held before the patch, with the identity absent.
        let original = before.clone();
        assert!(original.deployment_identity.is_none());

        apply_adoption(&mut before, &adopt.name, "2099-01-01T00:00:00Z");

        // Only the identity keys and `updated_at` moved.
        assert_eq!(before.display_name, original.display_name);
        assert_eq!(before.system_prompt, original.system_prompt);
        assert_eq!(before.model, original.model);
        assert_eq!(before.provider, original.provider);
        assert_eq!(before.runtime, original.runtime);
        assert_eq!(before.description, original.description);
        assert_eq!(before.name_pool, original.name_pool);
        assert_eq!(before.respond_to, original.respond_to);
        assert_eq!(before.respond_to_allowlist, original.respond_to_allowlist);
        assert_eq!(before.parallelism, original.parallelism);
        assert_eq!(before.is_active, original.is_active);
        assert_eq!(before.is_builtin, original.is_builtin);
        assert_eq!(before.catalog_source, original.catalog_source);
        assert_eq!(before.team_catalog_source, original.team_catalog_source);
        assert_eq!(before.created_at, original.created_at);
        assert_eq!(
            before.env_vars, original.env_vars,
            "a present selector is an addition-free no-op"
        );

        // And the two identity keys did move.
        assert_eq!(
            before
                .deployment_identity
                .as_ref()
                .map(|id| id.profile.as_str()),
            Some(adopt.name.as_str())
        );
    }
}

/// A deliberately ambiguous fixture stays `unmapped` through migration: two
/// rows hold the same selector, so neither may claim it.
#[test]
fn g1_ambiguous_fixture_stays_unmapped() {
    let mut personas = installed_roster();
    // Rename the original so the ambiguity is not also a name conflict: two
    // rows hold the selector and neither is named `coder`.
    for row in personas.iter_mut() {
        if row.display_name == "coder" {
            row.display_name = "coder-one".to_string();
        }
    }
    personas.push(persona("dup", "coder-two", Some("omp"), Some("coder")));
    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Unmapped, "{coder:?}");
    assert_eq!(coder.kind, Some(RosterVerdictKind::UnmappedClaimants));
    assert_eq!(coder.candidates.len(), 2, "both holders are offered");
    assert!(plan.apply_blocked);
}

/// A non-omp row holding the selector cannot be adopted: `OMP_PROFILE` on a
/// non-omp runtime is rejected, and flipping the runtime would be a second,
/// larger overwrite.
#[test]
fn g1_non_omp_holder_is_unmapped_not_adopted() {
    let mut personas = installed_roster();
    personas.retain(|row| row.display_name != "coder");
    personas.push(persona(
        "goose-coder",
        "Goose Coder",
        Some("goose"),
        Some("coder"),
    ));
    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Unmapped);
    assert_eq!(coder.kind, Some(RosterVerdictKind::UnmappedClaimants));
    assert!(coder.candidates.is_empty());
    assert_eq!(plan.counts.adopt, 4);
}

/// An explicit user mapping turns the question into an adoption.
#[test]
fn g1_user_mapping_resolves_unmapped_into_a_user_map_adopt() {
    let mut personas = installed_roster();
    for row in personas.iter_mut() {
        if row.display_name == "coder" {
            row.display_name = "my coder".to_string();
            row.env_vars.clear();
        }
    }
    let unresolved = plan(&personas);
    assert_eq!(entry(&unresolved, "coder").verdict, RosterVerdict::Unmapped);
    assert!(unresolved.apply_blocked);

    let mapping = ProfileMapping {
        name: "coder".to_string(),
        persona_id: "2726b5be".to_string(),
    };
    let mapped = plan_roster_deploy(&catalogue(), &personas, &[], &gates(), &[mapping]);
    let coder = entry(&mapped, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Adopt);
    assert_eq!(coder.via, Some(AdoptVia::UserMap));
    assert!(!mapped.apply_blocked);
}

// ── Duplicate provenance is damage, not a second deploy ──────────────────────

#[test]
fn two_rows_claiming_one_profile_is_reported_as_conflict() {
    let mut personas = installed_roster();
    personas[0].deployment_identity =
        Some(DeploymentIdentity::new("coder", "2026-09-20T00:00:00Z"));
    personas.push(persona(
        "clone",
        "coder-clone",
        Some("omp"),
        Some("reviewer"),
    ));
    personas[5].deployment_identity =
        Some(DeploymentIdentity::new("coder", "2026-09-20T00:00:00Z"));

    let plan = plan(&personas);
    let coder = entry(&plan, "coder");
    assert_eq!(coder.verdict, RosterVerdict::Conflict);
    assert_eq!(coder.kind, Some(RosterVerdictKind::DuplicateDeployment));
    // A conflict disables Apply, per the plan: the user must resolve the store
    // damage before a deploy can write, and the refreshed plan is what they see.
    assert!(plan.apply_blocked);
}

// ── Selector observations the catalogue cannot answer for ────────────────────

#[test]
fn an_undeclared_selector_is_reported_and_never_repaired() {
    let mut personas = installed_roster();
    personas.push(persona("stray", "stray", Some("omp"), Some("retired-role")));
    let plan = plan(&personas);
    assert_eq!(plan.not_installed.len(), 1);
    let observed = &plan.not_installed[0];
    assert_eq!(observed.selector, "retired-role");
    assert!(
        observed.message.contains("cannot be established"),
        "the message must not promise a fallback: {}",
        observed.message
    );
    // No verdict, no action: nothing in the roster is created or repaired by it.
    assert_eq!(plan.counts.create, 0);
    assert!(!plan.apply_blocked);
}

#[test]
fn a_malformed_selector_is_reported_as_manual_value() {
    let mut personas = installed_roster();
    personas.push(persona("odd", "odd", Some("omp"), Some("Not A Profile")));
    let plan = plan(&personas);
    assert_eq!(plan.manual_value.len(), 1);
    assert_eq!(plan.manual_value[0].selector, "Not A Profile");
    assert!(plan.not_installed.is_empty());
}

#[test]
fn an_empty_selector_is_neither_reported_kind() {
    let mut personas = installed_roster();
    personas.push(persona("fresh", "fresh", Some("omp"), Some("")));
    let plan = plan(&personas);
    assert!(plan.not_installed.is_empty());
    assert!(plan.manual_value.is_empty());
}

// ── Team presets ─────────────────────────────────────────────────────────────

fn built_team(id: &str, slug: &str, version: &str, persona_ids: Vec<&str>) -> TeamRecord {
    let preset = TEAM_PRESETS
        .iter()
        .find(|preset| preset.slug == slug)
        .expect("known preset");
    let mut team = crate::managed_agents::deployment::presets::new_preset_team(
        preset,
        id.to_string(),
        persona_ids.into_iter().map(str::to_string).collect(),
        "2026-09-20T00:00:00Z",
    );
    team.preset_source = Some(crate::managed_agents::TeamPresetSource::new(slug, version));
    team
}

/// The Build preset is deployable now; Design review is blocked until the
/// designer gate opens, and a blocked preset is never partially created.
#[test]
fn presets_are_planned_by_slug_and_design_review_is_blocked() {
    let personas = installed_roster();
    let plan = plan(&personas);
    let build = plan.teams.iter().find(|team| team.slug == "build").unwrap();
    assert_eq!(build.verdict, TeamPresetVerdict::Create);
    assert_eq!(build.member_profiles, vec!["coder", "reviewer", "scout"]);
    assert_eq!(
        build
            .members
            .iter()
            .filter_map(|member| member.persona_id.as_deref())
            .collect::<Vec<_>>()
            .len(),
        3,
        "every Build member resolves before the team exists"
    );

    let design = plan
        .teams
        .iter()
        .find(|team| team.slug == "design-review")
        .unwrap();
    assert_eq!(design.verdict, TeamPresetVerdict::Blocked);
    assert!(design.message.contains("designer"), "{}", design.message);
    assert!(design
        .members
        .iter()
        .any(|member| member.persona_id.is_none()));
}

/// A second deploy of an unchanged preset creates nothing and does not write.
#[test]
fn a_deployed_preset_reconciles_as_unchanged() {
    let personas = installed_roster();
    let teams = vec![built_team(
        "team-1",
        "build",
        "1",
        vec!["2726b5be", "705670a5", "ad0cc4d2"],
    )];
    let plan = plan_roster_deploy(&catalogue(), &personas, &teams, &gates(), &[]);
    let build = plan.teams.iter().find(|team| team.slug == "build").unwrap();
    assert_eq!(build.verdict, TeamPresetVerdict::Unchanged, "{build:?}");
    assert_eq!(build.team_id.as_deref(), Some("team-1"));
    assert!(
        build.expected_digest.is_some(),
        "an unchanged verdict carries the digest it compares"
    );
}

/// A rename or an instruction edit is preserved and reported as `edited` —
/// never rewritten back to the preset's own text.
#[test]
fn an_edited_preset_team_is_preserved_and_reported_edited() {
    let personas = installed_roster();
    let mut teams = vec![built_team(
        "team-1",
        "build",
        "1",
        vec!["2726b5be", "705670a5", "ad0cc4d2"],
    )];
    teams[0].name = "My Build".to_string();
    teams[0].instructions = Some("Always run the tests first.".to_string());
    let plan = plan_roster_deploy(&catalogue(), &personas, &teams, &gates(), &[]);
    let build = plan.teams.iter().find(|team| team.slug == "build").unwrap();
    assert_eq!(build.verdict, TeamPresetVerdict::Edited, "{build:?}");
    assert!(
        build.message.contains("preserved verbatim"),
        "{}",
        build.message
    );
}

/// Membership is a digest input, so a user who removed a member keeps that.
#[test]
fn a_removed_member_is_an_edit_not_a_silent_re_add() {
    let personas = installed_roster();
    let teams = vec![built_team(
        "team-1",
        "build",
        "1",
        vec!["2726b5be", "705670a5"],
    )];
    let plan = plan_roster_deploy(&catalogue(), &personas, &teams, &gates(), &[]);
    let build = plan.teams.iter().find(|team| team.slug == "build").unwrap();
    assert_eq!(build.verdict, TeamPresetVerdict::Edited);
    assert_eq!(
        build
            .members
            .iter()
            .filter_map(|member| member.persona_id.as_deref())
            .count(),
        3,
        "the plan still resolves all three members; it just refuses to re-add the removed one"
    );
}

/// A preset whose slug is absent from the store is a create even when another
/// team carries the same *name* — identity is the slug.
#[test]
fn a_same_named_team_without_provenance_is_not_the_preset() {
    let personas = installed_roster();
    let mut impostor = built_team("team-9", "build", "1", vec!["2726b5be"]);
    impostor.preset_source = None;
    let plan = plan_roster_deploy(&catalogue(), &personas, &[impostor], &gates(), &[]);
    let build = plan.teams.iter().find(|team| team.slug == "build").unwrap();
    assert_eq!(build.verdict, TeamPresetVerdict::Create);
}

/// `reviewer` belongs to both presets as one persona with two memberships; the
/// plan discloses that once instead of listing it twice.
#[test]
fn shared_members_are_disclosed_with_every_preset_that_uses_them() {
    let mut personas = installed_roster();
    personas.push(deployed(
        "designer-row",
        "designer",
        "designer",
        Some("designer"),
    ));
    let plan = plan_roster_deploy(&catalogue(), &personas, &[], &gates(), &[]);
    let shared: Vec<&SharedMember> = plan
        .shared_members
        .iter()
        .filter(|member| member.display_name == "reviewer")
        .collect();
    assert_eq!(shared.len(), 1, "reviewer is listed once");
    assert_eq!(
        shared[0].preset_slugs,
        vec!["build".to_string(), "design-review".to_string()]
    );
}

// ── Team preset planner is exercised directly too ────────────────────────────

#[test]
fn plan_teams_reports_a_create_with_no_stored_team() {
    let entries = plan(&installed_roster()).entries;
    let teams = plan_teams(&entries, &[]);
    assert_eq!(teams.len(), 2);
    assert!(teams
        .iter()
        .any(|team| team.verdict == TeamPresetVerdict::Create));
}
