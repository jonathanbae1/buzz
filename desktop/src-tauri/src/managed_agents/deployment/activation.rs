//! Machine-local activation proof for gated profiles.
//!
//! Exactly one owner for "may this profile be deployed here": a file the
//! installer never writes and `doctor.sh` only reads, under the same omp config
//! root as the generated catalogue:
//!
//! ```text
//! ${PI_CONFIG_DIR:-.omp}/oh-my-buzz/proofs.json
//! ```
//!
//! The generated manifest deliberately does **not** carry authorization. It is
//! role metadata the installer rewrites on every run; if it also expressed
//! authorization, regenerating it could silently grant or revoke a gate. Role
//! metadata and proof authorization are different facts, so they live in
//! different files (M2 plan, "Activation policy").
//!
//! Fail-closed on every failure mode: absent, unreadable, malformed, wrong
//! schema version, or naming a different omp version than the one running all
//! gate the profile. A UI flag is never a control — this module is the read the
//! Rust command boundary performs, so the gate holds for every caller.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::managed_agents::discovery::probe_version;

/// Bump when the record's meaning changes; an older schema fails closed.
const PROOF_SCHEMA_VERSION: u8 = 1;

const MAX_PROOF_BYTES: u64 = 64 * 1024;

/// One profile's authorization record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileProof {
    pub profile: String,
    /// The omp version the proof exercised. A record for a different version is
    /// not evidence about the running binary.
    pub omp_version: String,
    /// When the proof passed (RFC 3339). Audit only.
    pub proved_at: String,
    /// Free-form evidence note (nonce, gate name, …) written by whoever ran the
    /// proof. Never parsed.
    #[serde(default)]
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProofFile {
    schema_version: u8,
    #[serde(default)]
    proofs: Vec<ProfileProof>,
}

/// One gate's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationState {
    pub authorized: bool,
    pub reason: Option<String>,
}

impl ActivationState {
    fn authorized() -> Self {
        Self {
            authorized: true,
            reason: None,
        }
    }

    fn gated(reason: impl Into<String>) -> Self {
        Self {
            authorized: false,
            reason: Some(reason.into()),
        }
    }

    pub fn is_authorized(&self) -> bool {
        self.authorized
    }

    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
}

/// The gate's inputs, read once per command boundary.
///
/// Reading the file and probing the version are both I/O, so a caller that
/// gates every declared profile (the roster preview) loads this once rather
/// than paying for a probe per profile. The probe is bounded (see
/// [`probe_version`]), so a wedged omp binary cannot stall the command.
pub struct ActivationGates {
    path: PathBuf,
    proofs: Result<Vec<ProfileProof>, String>,
    running_version: Option<String>,
}

impl ActivationGates {
    pub fn load() -> Self {
        let path = proofs_path().unwrap_or_else(|| PathBuf::from("oh-my-buzz/proofs.json"));
        let proofs = read_proofs(&path);
        Self {
            path,
            proofs,
            running_version: probe_version("omp").map(|raw| normalize_omp_version(&raw)),
        }
    }

    #[cfg(test)]
    /// Build gates from explicit inputs — for tests and for a caller that has
    /// already resolved them, so the gate logic is exercised without I/O.
    pub fn from_parts(
        path: PathBuf,
        proofs: Result<Vec<ProfileProof>, String>,
        running_version: Option<String>,
    ) -> Self {
        Self {
            path,
            proofs,
            running_version,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Is `profile` authorized to be deployed on this machine?
    ///
    /// Two facts must both hold: the record names this profile, and it was
    /// taken against the omp version now running. A version that cannot be
    /// determined is a gate, not a pass — an unversioned record is evidence
    /// about an unknown binary.
    pub fn state(&self, profile: &str) -> ActivationState {
        let proofs = match self.proofs.as_ref() {
            Ok(proofs) => proofs,
            Err(reason) => return ActivationState::gated(reason.clone()),
        };
        let Some(proof) = proofs.iter().find(|proof| proof.profile == profile) else {
            return ActivationState::gated(format!("no activation proof records `{profile}`"));
        };
        let Some(running) = self.running_version.as_deref() else {
            return ActivationState::gated(
                "the installed omp version could not be determined, so the proof cannot be matched to it",
            );
        };
        if proof.omp_version != running {
            return ActivationState::gated(format!(
                "the recorded proof is for omp {} and {running} is installed",
                proof.omp_version
            ));
        }
        ActivationState::authorized()
    }

}

/// Resolve `proofs.json` under the same root the catalogue is read from.
///
/// Deliberately repeats `config_bridge::reader::safe_profile_config_dir`'s
/// resolution rules rather than sharing a function: that helper is private to
/// the reader and returns a manifest path, and the two files must stay in
/// lockstep by construction — same root, same relative directory. The rule that
/// matters (a `PI_CONFIG_DIR` must be relative, tilde-free, of normal path
/// components) is applied identically.
fn proofs_path() -> Option<PathBuf> {
    let configured = std::env::var("PI_CONFIG_DIR").ok();
    let configured = configured
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(".omp")
        .to_string();
    let path = Path::new(&configured);
    if path.is_absolute()
        || configured.contains('\\')
        || !path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    dirs::home_dir().map(|home| home.join(path).join("oh-my-buzz/proofs.json"))
}

/// Read the proof file. `Err` is the reason to show; the caller gates on it.
fn read_proofs(path: &Path) -> Result<Vec<ProfileProof>, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err("no activation proof is recorded on this machine".to_string())
        }
        Err(error) => return Err(format!("the activation proof could not be read: {error}")),
    };
    if metadata.len() > MAX_PROOF_BYTES {
        return Err("the activation proof is not a valid proof file".to_string());
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("the activation proof could not be read: {error}"))?;
    let file: ProofFile = serde_json::from_slice(&bytes)
        .map_err(|_| "the activation proof is malformed".to_string())?;
    if file.schema_version != PROOF_SCHEMA_VERSION {
        return Err(format!(
            "the activation proof uses schema version {} and this build reads {PROOF_SCHEMA_VERSION}",
            file.schema_version
        ));
    }
    Ok(file.proofs)
}

/// `omp/18.3.5`, `18.3.5`, or `omp 18.3.5` all normalize to `18.3.5`.
pub(crate) fn normalize_omp_version(raw: &str) -> String {
    let trimmed = raw.trim();
    let version = trimmed.rsplit(['/', ' ']).next().unwrap_or(trimmed);
    version.trim().to_string()
}

#[cfg(test)]
/// Serialize a proof list — used by the isolated-root fixture bootstrap and by
/// tests, never by a production write path.
pub fn encode_proofs(proofs: &[ProfileProof]) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(&ProofFile {
        schema_version: PROOF_SCHEMA_VERSION,
        proofs: proofs.to_vec(),
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
/// Build a proof record. Shaped for a fixture to write and a test to assert
/// against without touching the shared root.
pub fn proof_record(
    profile: &str,
    omp_version: &str,
    proved_at: &str,
    evidence: &str,
) -> ProfileProof {
    ProfileProof {
        profile: profile.to_string(),
        omp_version: omp_version.to_string(),
        proved_at: proved_at.to_string(),
        evidence: evidence.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gates(proofs: Result<Vec<ProfileProof>, String>, version: Option<&str>) -> ActivationGates {
        ActivationGates::from_parts(
            PathBuf::from("/tmp/does-not-matter/proofs.json"),
            proofs,
            version.map(str::to_string),
        )
    }

    #[test]
    fn absent_proof_file_gates() {
        let gates = gates(
            Err("no activation proof is recorded on this machine".to_string()),
            Some("18.3.5"),
        );
        let state = gates.state("designer");
        assert!(!state.authorized);
        assert!(state.reason().unwrap().contains("no activation proof"));
    }

    #[test]
    fn matching_version_authorizes() {
        let gates = gates(
            Ok(vec![proof_record("designer", "18.3.5", "now", "G4")]),
            Some("18.3.5"),
        );
        assert!(gates.state("designer").is_authorized());
    }

    #[test]
    fn version_mismatch_gates_and_names_both_versions() {
        let gates = gates(
            Ok(vec![proof_record("designer", "18.2.10", "now", "old")]),
            Some("18.3.5"),
        );
        let state = gates.state("designer");
        assert!(!state.authorized);
        let reason = state.reason().unwrap();
        assert!(reason.contains("18.2.10") && reason.contains("18.3.5"));
    }

    /// An unreadable running version must not open a gate: the record's version
    /// would have nothing to match against.
    #[test]
    fn unknown_running_version_gates_even_with_a_record() {
        let gates = gates(Ok(vec![proof_record("designer", "18.3.5", "now", "x")]), None);
        assert!(!gates.state("designer").is_authorized());
    }

    #[test]
    fn a_record_for_another_profile_does_not_authorize_this_one() {
        let gates = gates(
            Ok(vec![proof_record("reviewer", "18.3.5", "now", "x")]),
            Some("18.3.5"),
        );
        assert!(!gates.state("designer").is_authorized());
        assert!(gates.state("reviewer").is_authorized());
    }

    #[test]
    fn malformed_proof_file_gates_with_its_own_reason() {
        let gates = gates(Err("the activation proof is malformed".to_string()), Some("18.3.5"));
        assert_eq!(
            gates.state("designer").reason().unwrap(),
            "the activation proof is malformed"
        );
    }

    #[test]
    fn version_normalization_accepts_the_shapes_omp_prints() {
        assert_eq!(normalize_omp_version("omp/18.3.5"), "18.3.5");
        assert_eq!(normalize_omp_version("18.3.5"), "18.3.5");
        assert_eq!(normalize_omp_version("  omp 18.3.5  "), "18.3.5");
    }

    #[test]
    fn proof_file_round_trips_and_rejects_a_foreign_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proofs.json");
        std::fs::write(
            &path,
            encode_proofs(&[proof_record("designer", "18.3.5", "now", "G4")]).unwrap(),
        )
        .unwrap();
        let proofs = read_proofs(&path).unwrap();
        assert_eq!(proofs.len(), 1);
        assert_eq!(proofs[0].profile, "designer");

        std::fs::write(&path, br#"{"schemaVersion":99,"proofs":[]}"#).unwrap();
        let err = read_proofs(&path).unwrap_err();
        assert!(err.contains("schema version 99"), "{err}");

        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(read_proofs(&path).unwrap_err(), "the activation proof is malformed");

        std::fs::remove_file(&path).unwrap();
        assert!(
            read_proofs(&path)
                .unwrap_err()
                .contains("no activation proof is recorded")
        );
    }
}
