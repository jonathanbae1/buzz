//! G0/G1 replay over the **real installed store**.
//!
//! Read-only: it loads `agents/managed-agents.json` from the installed app's
//! data dir and replays the plan against it. The point of the gate is that the
//! predicate works against the bytes the app actually wrote, not only against
//! fixtures — the pre-M2 roster's five provenance-less rows are the case that
//! matters.
//!
//! Skips (with a printed reason) when the store is absent, so the suite stays
//! runnable on a machine that has no Buzz install. Never writes.

use std::path::PathBuf;

use crate::managed_agents::config_bridge::types::OmpProfileCatalogEntry;
use crate::managed_agents::deployment::activation::{proof_record, ActivationGates};
use crate::managed_agents::deployment::roster::{
    plan_roster_deploy, RosterDeployPlan, RosterVerdict,
};

const PRODUCTION_IDENTIFIER: &str = "xyz.block.buzz.app";

fn installed_store_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join("Library/Application Support")
            .join(PRODUCTION_IDENTIFIER)
            .join("agents/managed-agents.json"),
        home.join(".local/share")
            .join(PRODUCTION_IDENTIFIER)
            .join("agents/managed-agents.json"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

/// The catalogue as the installer currently emits it, read from the shared
/// root's manifest when it is present, so the replay uses the machine's real
/// declaration rather than a transcription.
fn installed_catalogue() -> Option<Vec<OmpProfileCatalogEntry>> {
    let catalog = crate::managed_agents::config_bridge::reader::read_omp_profile_catalog();
    if catalog.state != crate::managed_agents::config_bridge::types::OmpProfileState::Configured {
        return None;
    }
    Some(catalog.entries)
}

/// Rows in the shape `load_personas` presents: key-less definitions from the
/// unified store, presented as `AgentDefinition`.
fn installed_personas(path: &PathBuf) -> Vec<crate::managed_agents::AgentDefinition> {
    let bytes = std::fs::read(path).expect("read store");
    let records: Vec<crate::managed_agents::ManagedAgentRecord> =
        serde_json::from_slice(&bytes).expect("parse store");
    records
        .iter()
        .filter(|record| record.pubkey.is_empty())
        .filter_map(|record| record.to_definition_view())
        .collect()
}

fn replay() -> Option<(RosterDeployPlan, Vec<crate::managed_agents::AgentDefinition>)> {
    let path = installed_store_path()?;
    let catalogue = installed_catalogue()?;
    let personas = installed_personas(&path);
    // Prove every profile except the designer gate, so `unavailable` reflects
    // the gate's own behaviour rather than an empty fixture list.
    let proofs = catalogue
        .iter()
        .filter(|declaration| declaration.name != "designer")
        .map(|declaration| proof_record(&declaration.name, "fixture", "now", "G0 replay"))
        .collect();
    let gates = ActivationGates::from_parts(
        PathBuf::from("/tmp/g0-fixture/proofs.json"),
        Ok(proofs),
        Some("fixture".to_string()),
    );
    let plan = plan_roster_deploy(&catalogue, &personas, &[], &gates, &[]);
    Some((plan, personas))
}

/// Skips with a loud reason rather than silently passing — a skipped gate is
/// `UNVERIFIED`, never `passed`.
fn skip(reason: &str) {
    eprintln!("SKIP (UNVERIFIED): {reason}");
}

#[test]
fn g0_replay_over_the_real_installed_store_is_read_only_and_creates_nothing_for_deployed_profiles() {
    let Some((plan, personas)) = replay() else {
        skip("no installed Buzz store, or no readable profile catalogue, on this machine");
        return;
    };
    eprintln!(
        "real store: {} key-less definitions; plan counts {:?}",
        personas.len(),
        plan.counts
    );
    // Every profile the previous roster already deployed is recognized, so a
    // deploy from this state creates nothing for it. Profiles the roster never
    // deployed (`orchestrator` has no Buzz agent at all in some installs) may
    // legitimately be `create`.
    for entry in &plan.entries {
        eprintln!(
            "  {:<14} {:<10} {:?} {}",
            entry.name,
            format!("{:?}", entry.verdict),
            entry.kind,
            entry.persona_display_name.as_deref().unwrap_or("-")
        );
    }
    assert!(
        plan.counts.conflict == 0,
        "the real store must not present a conflict to a fresh plan: {:?}",
        plan.entries
            .iter()
            .filter(|entry| entry.verdict == RosterVerdict::Conflict)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        plan.entries
            .iter()
            .filter(|entry| entry.name == "default")
            .count(),
        1,
        "the ambient entry is present exactly once"
    );
    // The named exclusions from the plan: `default` is never a create, and the
    // gated profile is never a create.
    assert_ne!(
        plan.entries
            .iter()
            .find(|entry| entry.name == "default")
            .unwrap()
            .verdict,
        RosterVerdict::Create
    );
    assert_ne!(
        plan.entries
            .iter()
            .find(|entry| entry.name == "designer")
            .unwrap()
            .verdict,
        RosterVerdict::Create
    );
}

/// G1 over the real rows: the migration adopts each provenance-less legacy row
/// instead of minting a duplicate, and leaves the row's authored fields alone.
#[test]
fn g1_real_legacy_rows_are_adopted_and_the_unambiguous_ones_patch_only_identity() {
    let Some((plan, personas)) = replay() else {
        skip("no installed Buzz store on this machine");
        return;
    };
    eprintln!("real migration verdicts: {:?}", plan.counts);
    let legacy: Vec<_> = personas
        .iter()
        .filter(|persona| persona.deployment_identity.is_none())
        .filter(|persona| {
            persona
                .env_vars
                .get("OMP_PROFILE")
                .is_some_and(|value| !value.trim().is_empty())
        })
        .collect();
    if legacy.is_empty() {
        skip("this store's rows already carry deployment provenance");
        return;
    }
    for row in legacy {
        let entry = plan
            .entries
            .iter()
            .find(|entry| entry.persona_id.as_deref() == Some(row.id.as_str()));
        let Some(entry) = entry else {
            panic!(
                "legacy row `{}` (selector {:?}) is not accounted for by any plan entry",
                row.display_name, row.env_vars
            );
        };
        eprintln!(
            "  legacy `{}` -> {:?}",
            row.display_name, entry.verdict
        );
        // Never a create: a legacy row that is recognized must not be duplicated.
        assert_ne!(
            entry.verdict,
            RosterVerdict::Create,
            "a provenance-less legacy row must never produce a duplicate"
        );
        // And never a silent divergence report unless its selector really moved.
        if entry.verdict == RosterVerdict::Diverged {
            let selector = row.env_vars.get("OMP_PROFILE").map(String::as_str);
            assert_ne!(
                selector,
                Some(entry.name.as_str()),
                "a row whose selector still names its profile cannot be `diverged`"
            );
        }
    }
}
