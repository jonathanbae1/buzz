//! Private agentmemory Tasks adapter for the desktop.
//!
//! M1: read actions, dependencies, leases and assignment intent from the central
//! agentmemory service, and perform the three managed mutations the Tasks pane needs
//! (assign/unassign/cancel intent, register a dispatch, explicit cancel).
//!
//! Why this shape:
//! - **The bearer never leaves Rust.** The URL and secret are read from the machine's
//!   `~/.env` here, exactly like the hourly snapshot job does, and are never returned to
//!   JavaScript, never placed in a relay payload and never persisted in Buzz settings.
//! - **HTTPS is required** and credential-bearing redirects are disabled, so a redirect
//!   cannot carry the bearer to another host. The configured host is reported to the UI so
//!   the operator can see which store the pane is talking to. A hostname is not proof of
//!   tailnet membership and this module does not claim otherwise.
//! - **Errors are typed.** Auth failure, network failure, an incompatible contract and an
//!   empty board are four different outcomes; collapsing them into "no tasks" is the failure
//!   mode that hides a broken store behind a plausible screen.
//! - **Contract-checked.** Managed operations refuse when the store does not advertise the
//!   exact M1 contract, and absence (M1 not deployed) is reported as unavailable rather than
//!   as a hard error against an otherwise healthy legacy stack.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

/// The exact contract this client understands. A different advertised contract is refused.
const M1_CONTRACT: &str = "agentmemory-m1.1";

/// Project scope is explicit and fixed. It is never inferred from a channel or a filesystem path.
const PROJECT: &str = "oh-my-buzz";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// How the client classified the outcome. The UI shows a different surface for each.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskErrorKind {
    /// The service is not configured on this machine at all.
    NotConfigured,
    /// HTTPS was required but the configured URL is not HTTPS.
    InsecureUrl,
    /// The bearer was rejected.
    Unauthorized,
    /// The host could not be reached.
    Network,
    /// The store answered, but not with a usable response.
    Protocol,
    /// The store does not advertise the M1 contract (M1 not deployed).
    ContractMissing,
    /// The store advertises a contract this client does not understand.
    ContractIncompatible,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskError {
    pub kind: TaskErrorKind,
    pub message: String,
    /// The configured host, so the UI can show which store the pane is talking to.
    pub host: Option<String>,
    /// The advertised contract, when one was seen.
    pub contract: Option<String>,
}

impl TaskError {
    fn new(
        kind: TaskErrorKind,
        message: impl Into<String>,
        host: Option<String>,
        contract: Option<String>,
    ) -> Self {
        TaskError {
            kind,
            message: message.into(),
            host,
            contract,
        }
    }
}

type TaskResult<T> = Result<T, TaskError>;

/// The resolved store location. Never serialized to the frontend.
#[derive(Debug, Clone)]
struct Store {
    base: String,
    secret: String,
    host: String,
}

/// Locate the store configuration.
///
/// Order: process environment first (so a launched-by-Buzz session inherits what the harness
/// exported), then the machine's `~/.env`. `~/.env` is the one omp dotenv that is not
/// profile-scoped, which is why the snapshot job and all six profiles read it too.
fn resolve_store() -> TaskResult<Store> {
    let mut url = std::env::var("AGENTMEMORY_URL")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let mut secret = std::env::var("AGENTMEMORY_SECRET")
        .ok()
        .filter(|v| !v.trim().is_empty());

    if url.is_none() || secret.is_none() {
        if let Some((file_url, file_secret)) = read_env_file() {
            url = url.or(file_url);
            secret = secret.or(file_secret);
        }
    }

    let url = url.ok_or_else(|| {
        TaskError::new(
            TaskErrorKind::NotConfigured,
            "AGENTMEMORY_URL is not set in the environment or in ~/.env, so the Tasks pane has no store to read.",
            None,
            None,
        )
    })?;
    let secret = secret.ok_or_else(|| {
        TaskError::new(
            TaskErrorKind::NotConfigured,
            "AGENTMEMORY_SECRET is not set in the environment or in ~/.env.",
            host_of(&url),
            None,
        )
    })?;

    let base = url.trim().trim_end_matches('/').to_string();
    if !base.starts_with("https://") {
        // HTTP is refused rather than downgraded: the bearer would travel in clear text.
        return Err(TaskError::new(
            TaskErrorKind::InsecureUrl,
            format!("the configured store URL is not HTTPS ({base}). The Tasks pane refuses to send the bearer in clear text."),
            host_of(&base),
            None,
        ));
    }

    // An HTTPS URL always has a host component; `host_of` is total for that shape.
    let host = host_of(&base).unwrap_or_else(|| base.clone());
    Ok(Store { base, secret, host })
}

fn host_of(url: &str) -> Option<String> {
    url.split("://")
        .nth(1)
        .map(|rest| rest.split('/').next().unwrap_or(rest).to_string())
}

/// The configured store URL, from the environment then `~/.env`, without any scheme validation.
fn configured_url() -> Option<String> {
    let url = std::env::var("AGENTMEMORY_URL")
        .ok()
        .filter(|v| !v.trim().is_empty());
    if url.is_some() {
        return url;
    }
    read_env_file().and_then(|(file_url, _)| file_url)
}

/// Minimal `KEY=VALUE` reader for `~/.env`. Comments, blanks and surrounding quotes are handled;
/// nothing is executed and no shell is involved.
fn read_env_file() -> Option<(Option<String>, Option<String>)> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home).join(".env");
    let content = std::fs::read_to_string(path).ok()?;

    let mut url = None;
    let mut secret = None;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            value = &value[1..value.len() - 1];
        }
        match key {
            "AGENTMEMORY_URL" => url = Some(value.to_string()),
            "AGENTMEMORY_SECRET" => secret = Some(value.to_string()),
            _ => {}
        }
    }
    Some((url, secret))
}

/// A blocking client with redirects disabled, so the bearer cannot be forwarded elsewhere.
fn client() -> TaskResult<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        // A redirect carrying the Authorization header is exactly the credential leak this
        // module exists to prevent; a redirect to a new host is therefore a hard failure.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            TaskError::new(
                TaskErrorKind::Protocol,
                format!("could not build the HTTP client: {e}"),
                None,
                None,
            )
        })
}

fn classify(store: &Store, status: u16, body: Option<&Value>) -> Option<TaskError> {
    match status {
        401 | 403 => Some(TaskError::new(
            TaskErrorKind::Unauthorized,
            "the store rejected the bearer token. Check AGENTMEMORY_SECRET in ~/.env.",
            Some(store.host.clone()),
            None,
        )),
        300..=399 => Some(TaskError::new(
            TaskErrorKind::Protocol,
            "the store answered with a redirect. Credential-bearing redirects are disabled.",
            Some(store.host.clone()),
            None,
        )),
        _ if status >= 500 => Some(TaskError::new(
            TaskErrorKind::Protocol,
            body.and_then(|b| b.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("the store returned a server error.")
                .to_string(),
            Some(store.host.clone()),
            None,
        )),
        _ => None,
    }
}

fn send(store: &Store, method: &str, path: &str, body: Option<Value>) -> TaskResult<Value> {
    let client = client()?;
    let url = format!("{}/agentmemory{}", store.base, path);
    let mut request = match method {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => {
            return Err(TaskError::new(
                TaskErrorKind::Protocol,
                format!("unsupported method {other}"),
                Some(store.host.clone()),
                None,
            ))
        }
    }
    .header("authorization", format!("Bearer {}", store.secret));
    if let Some(payload) = body {
        request = request
            .header("content-type", "application/json")
            .json(&payload);
    }

    let response = request.send().map_err(|e| {
        TaskError::new(
            TaskErrorKind::Network,
            format!("could not reach the store at {}: {e}", store.host),
            Some(store.host.clone()),
            None,
        )
    })?;
    let status = response.status().as_u16();
    let parsed: Option<Value> = response.json().ok();
    if let Some(error) = classify(store, status, parsed.as_ref()) {
        return Err(error);
    }
    parsed.ok_or_else(|| {
        TaskError::new(
            TaskErrorKind::Protocol,
            format!("the store answered HTTP {status} without a JSON body."),
            Some(store.host.clone()),
            None,
        )
    })
}

/// Read and enforce the contract marker. Absence and mismatch are distinct.
fn require_contract(store: &Store) -> TaskResult<String> {
    let health = send(store, "GET", "/health", None)?;
    let advertised = health.get("m1Contract").and_then(Value::as_str);
    match advertised {
        None => Err(TaskError::new(
            TaskErrorKind::ContractMissing,
            "the store does not advertise the M1 contract, so managed work is unavailable (M1 not deployed). Reading legacy actions still works.",
            Some(store.host.clone()),
            None,
        )),
        Some(found) if found != M1_CONTRACT => Err(TaskError::new(
            TaskErrorKind::ContractIncompatible,
            format!("the store advertises contract {found}, but this app requires {M1_CONTRACT}."),
            Some(store.host.clone()),
            Some(found.to_string()),
        )),
        Some(found) => Ok(found.to_string()),
    }
}

/// Skip the contract check for the health call itself, which is what reports it.
fn health_payload(store: &Store) -> TaskResult<Value> {
    send(store, "GET", "/health", None)
}

// ── Types returned to the frontend ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBoard {
    /// Which store answered, so the operator can see it.
    pub host: Option<String>,
    /// The advertised contract, or null when the store is stock.
    pub contract: Option<String>,
    /// True when the pane may offer managed actions and Run.
    pub managed_available: bool,
    /// Why managed operations are unavailable, when they are.
    pub managed_unavailable_reason: Option<String>,
    pub tasks: Vec<TaskRow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: f64,
    pub project: Option<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Active execution owner. Not queued intent.
    pub assigned_to: Option<String>,
    /// Queued intent, revisioned.
    pub assignment_target: Option<String>,
    pub assignment_revision: i64,
    pub dispatch: Option<DispatchInfo>,
    pub lease_live: bool,
    pub lease_id: Option<String>,
    pub lease_agent: Option<String>,
    pub lease_expires_at: Option<String>,
    pub last_attempt: Option<AttemptInfo>,
    pub blockers: Vec<String>,
    /// The store's own readiness verdict. `ready` is not frontier membership.
    pub readiness: String,
    pub reasons: Vec<String>,
    pub result: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInfo {
    pub request_id: String,
    pub session_id: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptInfo {
    pub lease_id: String,
    pub request_id: String,
    pub session_id: String,
    pub outcome: Option<String>,
    pub result: Option<String>,
    pub at: String,
}

fn str_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn i64_field(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn f64_field(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or(5.0)
}

fn str_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn dispatch_of(action: &Value) -> Option<DispatchInfo> {
    let dispatch = action.get("assignment")?.get("dispatch")?;
    Some(DispatchInfo {
        request_id: str_field(dispatch, "requestId")?,
        session_id: str_field(dispatch, "sessionId")?,
        at: str_field(dispatch, "at").unwrap_or_default(),
    })
}

fn attempt_of(action: &Value) -> Option<AttemptInfo> {
    let attempt = action.get("lastAttempt")?;
    Some(AttemptInfo {
        lease_id: str_field(attempt, "leaseId")?,
        request_id: str_field(attempt, "requestId").unwrap_or_default(),
        session_id: str_field(attempt, "sessionId").unwrap_or_default(),
        outcome: str_field(attempt, "outcome"),
        result: str_field(attempt, "result"),
        at: str_field(attempt, "at").unwrap_or_default(),
    })
}

/// Build one row from an action plus its read projection.
///
/// The projection is fetched per action because readiness depends on the dependency graph and the
/// live lease, neither of which the list endpoint carries. The list is bounded, so this is N+1 on a
/// small N rather than a design claim.
fn row_from(action: &Value, projection: &Value) -> TaskRow {
    let lease = projection.get("lease").cloned().unwrap_or(Value::Null);
    let assignment = action.get("assignment").cloned().unwrap_or(Value::Null);
    TaskRow {
        id: str_field(action, "id").unwrap_or_default(),
        title: str_field(action, "title").unwrap_or_default(),
        description: str_field(action, "description").unwrap_or_default(),
        status: str_field(action, "status").unwrap_or_else(|| "pending".into()),
        priority: f64_field(action, "priority"),
        project: str_field(action, "project"),
        tags: str_array(action, "tags"),
        created_at: str_field(action, "createdAt").unwrap_or_default(),
        updated_at: str_field(action, "updatedAt").unwrap_or_default(),
        assigned_to: str_field(action, "assignedTo"),
        assignment_target: assignment
            .get("targetAgentId")
            .and_then(Value::as_str)
            .map(str::to_string),
        assignment_revision: i64_field(&assignment, "revision"),
        dispatch: dispatch_of(action),
        lease_live: lease.get("live").and_then(Value::as_bool).unwrap_or(false),
        lease_id: str_field(&lease, "id"),
        lease_agent: str_field(&lease, "agentId"),
        lease_expires_at: str_field(&lease, "expiresAt"),
        last_attempt: attempt_of(action),
        blockers: str_array(projection, "blockers"),
        readiness: str_field(projection, "readiness").unwrap_or_else(|| "unknown".into()),
        reasons: str_array(projection, "reasons"),
        result: str_field(action, "result"),
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    pub configured: bool,
    pub host: Option<String>,
    pub contract: Option<String>,
    pub service_version: Option<String>,
    pub managed_available: bool,
    /// Why managed operations are unavailable, when they are.
    pub managed_unavailable_reason: Option<String>,
    pub error: Option<TaskError>,
}

/// Why managed operations are refused for a given advertised contract.
fn unavailability(contract: Option<&str>) -> Option<String> {
    match contract {
        Some(found) if found == M1_CONTRACT => None,
        Some(found) => Some(format!("the store advertises contract {found}, but this app requires {M1_CONTRACT}")),
        None => Some(
            "the store does not advertise the M1 contract (M1 not deployed). Legacy actions are readable; managed work is unavailable."
                .to_string(),
        ),
    }
}

/// Report which store the pane is talking to and whether managed work is possible.
///
/// This is the ONE call that deliberately does not go through `resolve_store`'s HTTPS gate: its
/// whole job is to describe the configuration, including a configuration the client refuses to
/// USE. Reporting `configured: false` for a perfectly configured but insecure URL would hide the
/// real problem behind the wrong message.
pub fn agent_tasks_status_blocking() -> StoreStatus {
    let url = configured_url();
    let Some(raw_url) = url else {
        return StoreStatus {
            configured: false,
            host: None,
            contract: None,
            service_version: None,
            managed_available: false,
            managed_unavailable_reason: Some(
                "AGENTMEMORY_URL is not set in the environment or in ~/.env.".to_string(),
            ),
            error: Some(TaskError::new(
                TaskErrorKind::NotConfigured,
                "AGENTMEMORY_URL is not set in the environment or in ~/.env, so the Tasks pane has no store to read.",
                None,
                None,
            )),
        };
    };
    let base = raw_url.trim().trim_end_matches('/').to_string();
    let host = host_of(&base);
    if !base.starts_with("https://") {
        return StoreStatus {
            configured: true,
            host,
            contract: None,
            service_version: None,
            managed_available: false,
            managed_unavailable_reason: Some(
                "the configured store URL is not HTTPS, so managed work is refused.".to_string(),
            ),
            error: Some(TaskError::new(
                TaskErrorKind::InsecureUrl,
                format!("the configured store URL is not HTTPS ({base}). The Tasks pane refuses to send the bearer in clear text."),
                host_of(&base),
                None,
            )),
        };
    }
    let store = match resolve_store() {
        Ok(store) => store,
        Err(error) => {
            return StoreStatus {
                configured: true,
                host: error.host.clone(),
                contract: None,
                service_version: None,
                managed_available: false,
                managed_unavailable_reason: Some(error.message.clone()),
                error: Some(error),
            }
        }
    };
    match health_payload(&store) {
        Ok(health) => {
            let contract = health
                .get("m1Contract")
                .and_then(Value::as_str)
                .map(str::to_string);
            let unavailable = unavailability(contract.as_deref());
            StoreStatus {
                configured: true,
                host: Some(store.host.clone()),
                service_version: health
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                managed_available: unavailable.is_none(),
                managed_unavailable_reason: unavailable,
                contract,
                error: None,
            }
        }
        Err(error) => StoreStatus {
            configured: true,
            host: Some(store.host.clone()),
            contract: None,
            service_version: None,
            managed_available: false,
            managed_unavailable_reason: Some(error.message.clone()),
            error: Some(error),
        },
    }
}

/// List the project's actions with their assignment, lease and readiness projection.
pub fn agent_tasks_list_blocking() -> Result<TaskBoard, TaskError> {
    let store = resolve_store()?;
    let health = health_payload(&store)?;
    let contract = health
        .get("m1Contract")
        .and_then(Value::as_str)
        .map(str::to_string);
    let compatible = contract.as_deref() == Some(M1_CONTRACT);

    let listed = send(
        &store,
        "GET",
        &format!("/actions?project={PROJECT}&limit=200"),
        None,
    )?;
    let actions = listed
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut tasks = Vec::with_capacity(actions.len());
    for action in &actions {
        let Some(id) = str_field(action, "id") else {
            continue;
        };
        // The projection is what makes `ready` mean something: terminal, invalid target,
        // unresolved dependencies and live conflicts all prevent Run.
        let detail = send(&store, "GET", &format!("/actions/get?actionId={id}"), None)?;
        let projection = detail.clone();
        tasks.push(row_from(action, &projection));
    }

    let managed_unavailable_reason = unavailability(contract.as_deref());
    Ok(TaskBoard {
        host: Some(store.host.clone()),
        contract,
        managed_available: compatible,
        managed_unavailable_reason,
        tasks,
    })
}

/// Set or clear assignment INTENT, or cancel. Writes intent only and dispatches nothing.
pub fn agent_tasks_assign_blocking(
    action_id: String,
    target_agent_id: Option<String>,
    expected_revision: Option<i64>,
    cancel: Option<bool>,
) -> Result<Value, TaskError> {
    let store = resolve_store()?;
    require_contract(&store)?;
    send(
        &store,
        "POST",
        "/actions/assign",
        Some(json!({
            "actionId": action_id,
            "targetAgentId": if cancel.unwrap_or(false) { None } else { target_agent_id },
            "expectedRevision": expected_revision,
            "cancel": cancel.unwrap_or(false),
            "actor": "buzz-tasks-pane",
        })),
    )
}

/// Register the dispatch BEFORE anything is sent to a worker.
pub fn agent_tasks_register_dispatch_blocking(
    action_id: String,
    request_id: String,
    session_id: String,
    expected_revision: i64,
) -> Result<Value, TaskError> {
    let store = resolve_store()?;
    require_contract(&store)?;
    send(
        &store,
        "POST",
        "/actions/assign",
        Some(json!({
            "actionId": action_id,
            "expectedRevision": expected_revision,
            "dispatch": { "requestId": request_id, "sessionId": session_id },
            "actor": "buzz-tasks-pane",
        })),
    )
}

/// Read one action's authoritative state, used to reconcile an uncertain dispatch.
pub fn agent_tasks_get_blocking(action_id: String) -> Result<Value, TaskError> {
    let store = resolve_store()?;
    send(
        &store,
        "GET",
        &format!("/actions/get?actionId={action_id}"),
        None,
    )
}

#[cfg(test)]
mod probe {
    //! Opt-in against a running store: `AGENTMEMORY_URL=... AGENTMEMORY_SECRET=... \
    //!   cargo test -p buzz-desktop --lib agent_tasks -- --ignored --nocapture`
    //!
    //! These assertions are about classification, not about a stored fixture: the same call must
    //! produce distinctly different errors for a missing contract, a wrong one, a bad bearer and an
    //! unreachable host. That distinction is the whole reason the UI can avoid showing an empty
    //! board when the store is broken.
    use super::*;

    fn configured() -> bool {
        std::env::var("AGENTMEMORY_URL").is_ok() && std::env::var("AGENTMEMORY_SECRET").is_ok()
    }

    #[test]
    #[ignore = "requires a running agentmemory store; run explicitly with --ignored"]
    fn classifies_the_configured_store_by_reachability() {
        if !configured() {
            eprintln!("skipping: AGENTMEMORY_URL/AGENTMEMORY_SECRET are not set");
            return;
        }
        let url = std::env::var("AGENTMEMORY_URL").unwrap();
        let status = agent_tasks_status_blocking();
        assert!(
            status.configured,
            "a configured store must report configured=true"
        );
        assert!(
            status.host.is_some(),
            "a configured store must report its host"
        );
        eprintln!("status = {status:?}");

        if url.starts_with("https://") {
            if status.managed_available {
                let board = agent_tasks_list_blocking().expect("a compatible store must list");
                eprintln!("rows = {}", board.tasks.len());
            } else {
                assert!(
                    status.managed_unavailable_reason.is_some(),
                    "unavailability must carry a reason"
                );
                let error = agent_tasks_list_blocking().expect_err("managed work must be refused");
                assert!(
                    matches!(
                        error.kind,
                        TaskErrorKind::ContractMissing
                            | TaskErrorKind::ContractIncompatible
                            | TaskErrorKind::Network
                            | TaskErrorKind::Unauthorized
                    ),
                    "unexpected classification: {:?}",
                    error.kind
                );
            }
            return;
        }

        // A plain-HTTP store must be refused outright rather than downgraded, because the bearer
        // would otherwise travel in clear text. This is the security property the adapter exists
        // to enforce, and it is observable on any HTTP endpoint.
        assert!(
            !status.managed_available,
            "plain HTTP must never be managed-available"
        );
        let error = agent_tasks_list_blocking().expect_err("plain HTTP must be refused");
        assert!(
            matches!(error.kind, TaskErrorKind::InsecureUrl),
            "plain HTTP must classify as InsecureUrl, got {:?}: {}",
            error.kind,
            error.message
        );
        eprintln!("plain HTTP refused as expected: {}", error.message);
    }

    #[test]
    fn an_insecure_url_is_refused_before_any_request() {
        // 127.0.0.1 over plain HTTP is the exact shape a misconfigured client would use, and the
        // bearer would travel in clear text.
        std::env::set_var("AGENTMEMORY_URL", "http://127.0.0.1:3311");
        std::env::set_var("AGENTMEMORY_SECRET", "unused");
        let error = resolve_store().expect_err("plain HTTP must be refused");
        assert!(
            matches!(error.kind, TaskErrorKind::InsecureUrl),
            "{error:?}"
        );
        std::env::remove_var("AGENTMEMORY_URL");
        std::env::remove_var("AGENTMEMORY_SECRET");
    }
}

// Tauri runs synchronous commands on the main thread, so each blocking store,
// file or git call above is dispatched to the blocking pool; otherwise a slow
// request freezes the whole window.
#[tauri::command]
pub async fn agent_tasks_status() -> StoreStatus {
    tauri::async_runtime::spawn_blocking(agent_tasks_status_blocking)
        .await
        .unwrap_or_else(|error| panic!("agent_tasks_status worker failed: {error}"))
}

#[tauri::command]
pub async fn agent_tasks_list() -> Result<TaskBoard, TaskError> {
    tauri::async_runtime::spawn_blocking(agent_tasks_list_blocking)
        .await
        .unwrap_or_else(|error| {
            Err(TaskError::new(
                TaskErrorKind::Protocol,
                format!("task store worker failed: {error}"),
                None,
                None,
            ))
        })
}

#[tauri::command]
pub async fn agent_tasks_assign(
    action_id: String,
    target_agent_id: Option<String>,
    expected_revision: Option<i64>,
    cancel: Option<bool>,
) -> Result<Value, TaskError> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_tasks_assign_blocking(action_id, target_agent_id, expected_revision, cancel)
    })
    .await
    .unwrap_or_else(|error| {
        Err(TaskError::new(
            TaskErrorKind::Protocol,
            format!("task store worker failed: {error}"),
            None,
            None,
        ))
    })
}

#[tauri::command]
pub async fn agent_tasks_register_dispatch(
    action_id: String,
    request_id: String,
    session_id: String,
    expected_revision: i64,
) -> Result<Value, TaskError> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_tasks_register_dispatch_blocking(action_id, request_id, session_id, expected_revision)
    })
    .await
    .unwrap_or_else(|error| {
        Err(TaskError::new(
            TaskErrorKind::Protocol,
            format!("task store worker failed: {error}"),
            None,
            None,
        ))
    })
}

#[tauri::command]
pub async fn agent_tasks_get(action_id: String) -> Result<Value, TaskError> {
    tauri::async_runtime::spawn_blocking(move || agent_tasks_get_blocking(action_id))
        .await
        .unwrap_or_else(|error| {
            Err(TaskError::new(
                TaskErrorKind::Protocol,
                format!("task store worker failed: {error}"),
                None,
                None,
            ))
        })
}
