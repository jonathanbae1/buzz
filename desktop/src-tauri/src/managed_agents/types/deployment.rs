//! Deployment provenance for a persona the roster deploy created, and for a
//! team a preset created. Split from `types.rs` (file-size cap), alongside
//! [`super::CatalogSource`] and [`super::TeamCatalogSource`].

use serde::{Deserialize, Serialize};

/// Immutable answer to "did deployment already create this persona?".
///
/// Deliberately NOT the runtime selector. `env_vars.OMP_PROFILE` answers "what
/// does this agent run as?" and is user-editable; this field answers "which
/// installed profile was this agent deployed for?" and is written once at first
/// claim, then never rewritten. Clearing or changing the selector is a
/// legitimate user edit, so deployment reports the disagreement
/// (`diverged`) instead of restoring one from the other (M2 plan, "Identity
/// and keying").
///
/// Local provenance, like [`super::CatalogSource`]: it is not part of the
/// persona's published projection, so `persona_content_hash` stays stable when
/// it is written.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeploymentIdentity {
    /// The installed omp profile this persona was deployed for. Immutable so a
    /// later rename of the selector cannot make an already-deployed row look
    /// new and mint a duplicate.
    pub profile: String,
    /// When the claim was written (RFC 3339). Audit only — never compared.
    pub deployed_at: String,
}

impl DeploymentIdentity {
    pub fn new(profile: impl Into<String>, deployed_at: impl Into<String>) -> Self {
        Self {
            profile: profile.into(),
            deployed_at: deployed_at.into(),
        }
    }
}

/// Provenance of a team a deployment preset created.
///
/// The analogue of [`super::TeamCatalogSource`] for the first-party case: the
/// copy carries a fresh local id, so `(slug, version)` is the only link back to
/// the preset that created it, and the only thing that can answer "is this
/// preset already deployed". Deliberately not `is_builtin` — a built-in is
/// auto-seeded on load by id, whereas a preset is opt-in and must not appear in
/// a store the user never deployed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TeamPresetSource {
    /// Stable preset identity. Reconcile by this, never by display name.
    pub slug: String,
    /// Preset version this copy was built from. A later release that changes a
    /// preset's roster or content is a change to display, not a silent re-add.
    pub version: String,
}

impl TeamPresetSource {
    pub fn new(slug: impl Into<String>, version: impl Into<String>) -> Self {
        Self {
            slug: slug.into(),
            version: version.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trip the persisted shape: snake_case on disk, and a record written
    /// before the field existed still parses.
    #[test]
    fn deployment_identity_round_trips_and_is_optional() {
        let identity = DeploymentIdentity::new("coder", "2026-09-28T00:00:00Z");
        let json = serde_json::to_string(&identity).unwrap();
        assert_eq!(json, r#"{"profile":"coder","deployed_at":"2026-09-28T00:00:00Z"}"#);
        assert_eq!(
            serde_json::from_str::<DeploymentIdentity>(&json).unwrap(),
            identity
        );
    }

    #[test]
    fn team_preset_source_round_trips() {
        let source = TeamPresetSource::new("build", "1");
        let json = serde_json::to_string(&source).unwrap();
        assert_eq!(json, r#"{"slug":"build","version":"1"}"#);
        assert_eq!(
            serde_json::from_str::<TeamPresetSource>(&json).unwrap(),
            source
        );
    }
}
