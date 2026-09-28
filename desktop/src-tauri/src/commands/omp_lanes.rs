use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const SCHEMA_VERSION: u32 = 1;
const SAVE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneEntry {
    pub key: String,
    pub label: String,
    pub model: String,
    pub alias_of: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub used_by: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneEditorState {
    pub state: String,
    pub repo_path: Option<String>,
    pub lanes: Vec<OmpLaneEntry>,
    pub dead_ids: Vec<String>,
    pub providers: Vec<String>,
    pub unavailable_reason: Option<String>,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpModelChoice {
    pub selector: String,
    pub name: String,
    pub efforts: Vec<String>,
    pub reasoning: bool,
    pub dead: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpHostIdentity {
    pub executable: String,
    pub version: String,
    pub config_root: String,
    pub managed: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpModelCatalog {
    pub models: Vec<OmpModelChoice>,
    pub fetched_at: String,
    pub host: OmpHostIdentity,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneProblem {
    pub code: String,
    pub lane: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneResolved {
    pub key: String,
    pub model: String,
    pub effort: Option<String>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLanePreview {
    pub ok: bool,
    pub revision: String,
    pub diff: String,
    pub problems: Vec<OmpLaneProblem>,
    pub resolved: Vec<OmpLaneResolved>,
    pub affected_profiles: Vec<String>,
    pub running_agents: Vec<Value>,
    pub host: OmpHostIdentity,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpProfileApplyState {
    pub profile: String,
    pub state: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpRecordApplyState {
    pub profile: String,
    pub record: String,
    pub state: String,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneSaveOutcome {
    pub source: String,
    pub profiles: Vec<OmpProfileApplyState>,
    pub records: Vec<OmpRecordApplyState>,
    pub backups: Option<String>,
    pub recovery: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneRepoStatus {
    pub git_present: bool,
    pub lanes_dirty: bool,
    pub lanes_revision: Option<String>,
    pub unrelated_dirty_paths: Vec<String>,
    pub head: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OmpLaneCommitOutcome {
    pub committed: bool,
    pub sha: Option<String>,
    pub branch: Option<String>,
    pub refused: Option<String>,
    pub output: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSidecar {
    schema_version: u32,
    repo_path: String,
    lanes: Value,
    dead_ids: Vec<String>,
    providers: Vec<String>,
    host: SidecarHost,
}


#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarHost {
    executable: String,
    version: String,
    config_root: String,
    managed: bool,
}


fn host_sidecar_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
    let config_dir = std::env::var_os("PI_CONFIG_DIR").unwrap_or_else(|| ".omp".into());
    Ok(PathBuf::from(home).join(config_dir).join("oh-my-buzz/host.json"))
}

fn read_sidecar(repo: Option<&Path>) -> Result<(HostSidecar, PathBuf), String> {
    let path = host_sidecar_path()?;
    let bytes = fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let sidecar: HostSidecar = serde_json::from_slice(&bytes)
        .map_err(|e| format!("invalid {}: {e}", path.display()))?;
    if sidecar.schema_version != SCHEMA_VERSION {
        return Err(format!("unsupported host sidecar schema {}", sidecar.schema_version));
    }
    if !sidecar.lanes.is_object() {
        return Err("host sidecar lanes must be an object".into());
    }
    let repo_path = PathBuf::from(&sidecar.repo_path);
    if !repo_path.is_dir() || !repo_path.join("profiles/lanes.json").is_file() {
        return Err("the configured oh-my-buzz repository is missing".into());
    }
    if let Some(expected) = repo {
        if expected != repo_path {
            return Err("repository path does not match the installed lane sidecar".into());
        }
    }
    Ok((sidecar, repo_path))
}

fn host_identity(sidecar: &HostSidecar) -> OmpHostIdentity {
    OmpHostIdentity {
        executable: sidecar.host.executable.clone(),
        version: sidecar.host.version.clone(),
        config_root: sidecar.host.config_root.clone(),
        managed: sidecar.host.managed,
    }
}

fn lock_path() -> Result<PathBuf, String> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or("no state directory is available")?;
    Ok(state.join("oh-my-buzz/routing.lock"))
}

struct RoutingLock(File);

impl RoutingLock {
    fn acquire() -> Result<Self, String> {
        let path = lock_path()?;
        let parent = path.parent().ok_or("invalid routing lock path")?;
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        let file = OpenOptions::new().create(true).read(true).write(true).open(&path)
            .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        let start = Instant::now();
        loop {
            let rc = unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&file), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 { return Ok(Self(file)); }
            if start.elapsed() >= Duration::from_secs(30) {
                return Err(format!("lock_timeout: routing lock held at {}", path.display()));
            }
            thread::sleep(Duration::from_secs(2));
        }
    }
}

impl Drop for RoutingLock {
    fn drop(&mut self) {
        unsafe { libc::flock(std::os::fd::AsRawFd::as_raw_fd(&self.0), libc::LOCK_UN); }
    }
}

fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn lanes_path(repo: &Path) -> PathBuf { repo.join("profiles/lanes.json") }

fn lane_entries(value: &Value) -> Result<Vec<OmpLaneEntry>, String> {
    let lanes = value.get("lanes").and_then(Value::as_object).ok_or("lanes must be an object")?;
    lanes.iter().map(|(key, lane)| {
        let model = lane.get("model").and_then(Value::as_str).ok_or_else(|| format!("{key}.model must be a string"))?.to_string();
        let effort = match lane.get("effort") {
            Some(Value::Null) | None => None,
            Some(Value::String(v)) if !v.is_empty() => Some(v.clone()),
            _ => return Err(format!("{key}.effort must be null or a non-empty string")),
        };
        let alias_of = model.strip_prefix('@').map(str::to_string);
        Ok(OmpLaneEntry { key: key.clone(), label: key.clone(), model, alias_of, effort, used_by: Vec::new() })
    }).collect()
}

fn run_capture_env(
    exe: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    timeout: Duration,
    env: &[(&str, &str)],
) -> Result<(i32, String, String, bool), String> {
    let mut command = Command::new(exe);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).envs(env.iter().copied());
    command.env_remove("OMP_PROFILE").env_remove("PI_PROFILE");
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    let mut stdout = child.stdout.take().ok_or("stdout pipe unavailable")?;
    let mut stderr = child.stderr.take().ok_or("stderr pipe unavailable")?;
    let out_reader = thread::spawn(move || { let mut b = Vec::new(); let _ = stdout.read_to_end(&mut b); b });
    let err_reader = thread::spawn(move || { let mut b = Vec::new(); let _ = stderr.read_to_end(&mut b); b });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if start.elapsed() >= timeout {
            timed_out = true;
            #[cfg(unix)]
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let out = out_reader.join().map_err(|_| "stdout reader panicked")?;
    let err = err_reader.join().map_err(|_| "stderr reader panicked")?;
    Ok((status.code().unwrap_or(128), String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned(), timed_out))
}

fn read_profile_record(exe: &Path, config_dir: &Path, record: &str) -> Result<Value, String> {
    let config_dir = config_dir.to_str().ok_or("invalid profile config path")?;
    let (code, stdout, stderr, timed_out) = run_capture_env(
        exe, &["config", "get", record, "--json"], None, Duration::from_secs(10),
        &[("PI_CODING_AGENT_DIR", config_dir)],
    )?;
    if timed_out || code != 0 {
        return Err(format!("config get {record} failed (exit {code}, timeout={timed_out}): {stderr}"));
    }
    let output: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("invalid config get {record} JSON: {e}"))?;
    output.get("value").cloned().ok_or_else(|| format!("config get {record} omitted value"))
}

fn expected_profile_records(repo: &Path, profile: &str) -> Result<(Value, Value), String> {
    let script = ". \"$REPO/profiles/routing.conf\" && profile_model_roles \"$1\" && printf '\\n' && printf '%s\\n' \"$DEFAULT_AGENT_MODELS\"";
    let output = Command::new("sh").args(["-c", script, "sh", profile]).env("REPO", repo).output()
        .map_err(|e| format!("could not derive expected records: {e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    let text = String::from_utf8_lossy(&output.stdout);
    let (roles, agents) = text.split_once('\n').ok_or("routing record derivation returned incomplete output")?;
    Ok((serde_json::from_str(roles).map_err(|e| e.to_string())?, serde_json::from_str(agents).map_err(|e| e.to_string())?))
}

fn profile_config_dir(config_root: &Path, profile: &str) -> PathBuf {
    if profile == "default" { config_root.join("agent") }
    else { config_root.join("profiles").join(profile).join("agent") }
}

fn verify_profile_records(exe: &Path, config_root: &Path, repo: &Path, profile: &str) -> (OmpProfileApplyState, Vec<OmpRecordApplyState>) {
    let dir = profile_config_dir(config_root, profile);
    let (expected_roles, expected_agents) = match expected_profile_records(repo, profile) {
        Ok(records) => records,
        Err(error) => return (
            OmpProfileApplyState { profile: profile.into(), state: "appliedUnverified".into(), detail: Some(error.clone()) },
            ["modelRoles", "task.agentModelOverrides"].iter().map(|record| OmpRecordApplyState {
                profile: profile.into(), record: (*record).into(), state: "appliedUnverified".into(), detail: Some(error.clone()),
            }).collect(),
        ),
    };
    let mut records = Vec::new();
    let mut verified = true;
    for (record, expected) in [("modelRoles", expected_roles), ("task.agentModelOverrides", expected_agents)] {
        match read_profile_record(exe, &dir, record) {
            Ok(observed) if observed == expected => records.push(OmpRecordApplyState {
                profile: profile.into(), record: record.into(), state: "applied".into(), detail: None,
            }),
            Ok(observed) => {
                verified = false;
                records.push(OmpRecordApplyState {
                    profile: profile.into(), record: record.into(), state: "appliedUnverified".into(), detail: Some(observed.to_string()),
                });
            }
            Err(error) => {
                verified = false;
                records.push(OmpRecordApplyState {
                    profile: profile.into(), record: record.into(), state: "appliedUnverified".into(), detail: Some(error),
                });
            }
        }
    }
    (OmpProfileApplyState {
        profile: profile.into(), state: if verified { "applied".into() } else { "appliedUnverified".into() }, detail: None,
    }, records)
}
fn run_capture(exe: &Path, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Result<(i32, String, String, bool), String> {
    let mut command = Command::new(exe);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    let mut stdout = child.stdout.take().ok_or("stdout pipe unavailable")?;
    let mut stderr = child.stderr.take().ok_or("stderr pipe unavailable")?;
    let out_reader = thread::spawn(move || { let mut b = Vec::new(); let _ = stdout.read_to_end(&mut b); b });
    let err_reader = thread::spawn(move || { let mut b = Vec::new(); let _ = stderr.read_to_end(&mut b); b });
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if start.elapsed() >= timeout {
            timed_out = true;
            #[cfg(unix)]
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            let _ = child.kill();
            break child.wait().map_err(|e| e.to_string())?;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let out = out_reader.join().map_err(|_| "stdout reader panicked")?;
    let err = err_reader.join().map_err(|_| "stderr reader panicked")?;
    Ok((status.code().unwrap_or(128), String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned(), timed_out))
}

fn validate_candidate(repo: &Path, candidate: &Path) -> Vec<OmpLaneProblem> {
    let script = ". \"$REPO/profiles/routing.conf\" && lanes_gate \"$1\"";
    let output = Command::new("sh").arg("-c").arg(script).arg("sh").arg(candidate)
        .env("REPO", repo).output();
    let Ok(output) = output else {
        return vec![OmpLaneProblem { code: "gate_unavailable".into(), lane: None, message: "could not start routing gate".into() }];
    };
    let mut problems = String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        let mut parts = line.splitn(3, '|');
        let code = parts.next()?.to_string();
        let lane = parts.next().filter(|s| *s != "-").map(str::to_string);
        let message = parts.next().unwrap_or("lane rejected").to_string();
        Some(OmpLaneProblem { code, lane, message })
    }).collect::<Vec<_>>();
    if !output.status.success() && problems.is_empty() {
        problems.push(OmpLaneProblem {
            code: "gate_unavailable".into(), lane: None,
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    problems
}

fn lane_usage(repo: &Path, key: &str) -> Result<Vec<String>, String> {
    let output = Command::new("sh")
        .arg("-c")
        .arg(". \"$REPO/profiles/routing.conf\" && lane_used_by \"$1\"")
        .arg("sh")
        .arg(key)
        .env("REPO", repo)
        .output()
        .map_err(|e| format!("could not read lane consumers: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect())
}

fn render_lanes(lanes: &[OmpLaneEntry]) -> Result<Vec<u8>, String> {
    let mut entries = serde_json::Map::new();
    for lane in lanes {
        if lane.key.is_empty() || lane.key.contains('/') || lane.key.contains('\\') {
            return Err(format!("invalid lane key: {}", lane.key));
        }
        entries.insert(lane.key.clone(), serde_json::json!({ "model": lane.model, "effort": lane.effort }));
    }
    let value = serde_json::json!({"schemaVersion":1,"lanes":entries});
    let mut bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn temp_path(repo: &Path, suffix: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    repo.join("profiles").join(format!(".lanes-{nonce}-{suffix}.tmp"))
}

fn resolved_lanes(value: &Value) -> Vec<OmpLaneResolved> {
    let mut result = Vec::new();
    let Some(lanes) = value.get("lanes").and_then(Value::as_object) else { return result; };
    for (key, lane) in lanes {
        let mut current = key.as_str();
        let mut seen = std::collections::HashSet::new();
        let mut model = String::new();
        while seen.insert(current.to_string()) {
            let Some(item) = lanes.get(current) else { break; };
            let Some(value) = item.get("model").and_then(Value::as_str) else { break; };
            if let Some(alias) = value.strip_prefix('@') { current = alias; } else { model = value.to_string(); break; }
        }
        result.push(OmpLaneResolved { key: key.clone(), model, effort: lane.get("effort").and_then(Value::as_str).map(str::to_string), source: lane.get("model").and_then(Value::as_str).unwrap_or("").into() });
    }
    result
}

#[tauri::command]
pub fn get_omp_lane_editor_state() -> OmpLaneEditorState {
    let state = (|| -> Result<_, String> {
        let (sidecar, repo) = read_sidecar(None)?;
        let current_bytes = fs::read(lanes_path(&repo)).map_err(|e| e.to_string())?;
        let current: Value = serde_json::from_slice(&current_bytes).map_err(|e| e.to_string())?;
        let stale = sidecar.lanes != current.get("lanes").cloned().unwrap_or(Value::Null);
        let mut lanes = lane_entries(&current)?;
        for lane in &mut lanes {
            lane.used_by = lane_usage(&repo, &lane.key)?;
        }
        Ok(OmpLaneEditorState { state: "configured".into(), repo_path: Some(repo.display().to_string()), lanes, dead_ids: sidecar.dead_ids, providers: sidecar.providers, unavailable_reason: None, stale })
    })();
    match state {
        Ok(state) => state,
        Err(reason) => OmpLaneEditorState { state: "unavailable".into(), repo_path: None, lanes: Vec::new(), dead_ids: Vec::new(), providers: Vec::new(), unavailable_reason: Some(reason), stale: false },
    }
}

#[tauri::command]
pub fn get_omp_model_catalog(repo_path: String) -> Result<OmpModelCatalog, String> {
    let repo = PathBuf::from(repo_path);
    let (sidecar, resolved_repo) = read_sidecar(Some(&repo))?;
    if resolved_repo != repo { return Err("repository path is not canonical".into()); }
    let exe = PathBuf::from(&sidecar.host.executable);
    let (code, stdout, stderr, timed_out) = run_capture(&exe, &["models", "--json", "--no-extensions"], Some(&repo), Duration::from_secs(30))?;
    if timed_out || code != 0 { return Err(format!("model catalog failed (exit {code}, timeout={timed_out}): {stderr}")); }
    let json: Value = serde_json::from_str(&stdout).map_err(|e| format!("invalid model catalog JSON: {e}; stderr: {stderr}"))?;
    let models = json.get("models").and_then(Value::as_array).ok_or("model catalog has no models array")?;
    let choices = models.iter().filter_map(|model| {
        let selector = model.get("selector")?.as_str()?.to_string();
        let name = model.get("name").and_then(Value::as_str).unwrap_or(&selector).to_string();
        let efforts = model.get("thinking").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        Some(OmpModelChoice { dead: sidecar.dead_ids.contains(&selector), selector, name, efforts, reasoning: model.get("reasoning").and_then(Value::as_bool).unwrap_or(false) })
    }).collect();
    Ok(OmpModelCatalog { models: choices, fetched_at: chrono::Utc::now().to_rfc3339(), host: host_identity(&sidecar) })
}

#[tauri::command]
pub fn preview_omp_lanes(repo_path: String, lanes: Vec<OmpLaneEntry>) -> Result<OmpLanePreview, String> {
    let _lock = RoutingLock::acquire()?;
    let repo = PathBuf::from(repo_path);
    let (sidecar, repo) = read_sidecar(Some(&repo))?;
    let path = lanes_path(&repo);
    let old = fs::read(&path).map_err(|e| e.to_string())?;
    let candidate_bytes = render_lanes(&lanes)?;
    let old_path = temp_path(&repo, "before");
    let candidate = temp_path(&repo, "preview");
    fs::write(&old_path, &old).map_err(|e| e.to_string())?;
    fs::write(&candidate, &candidate_bytes).map_err(|e| e.to_string())?;
    let problems = validate_candidate(&repo, &candidate);
    let diff_result = Command::new("diff")
        .args(["-u", "--label", "profiles/lanes.json"])
        .arg(&old_path)
        .args(["--label", "profiles/lanes.json"])
        .arg(&candidate)
        .output()
        .map_err(|e| format!("could not create lane diff: {e}"))?;
    let _ = fs::remove_file(&old_path);
    let _ = fs::remove_file(&candidate);
    if !matches!(diff_result.status.code(), Some(0 | 1)) {
        return Err(String::from_utf8_lossy(&diff_result.stderr).trim().to_string());
    }
    let diff = String::from_utf8_lossy(&diff_result.stdout).into_owned();
    let document: Value = serde_json::from_slice(&candidate_bytes).unwrap_or(Value::Null);
    Ok(OmpLanePreview { ok: problems.is_empty(), revision: hash(&old), diff, problems, resolved: resolved_lanes(&document), affected_profiles: Vec::new(), running_agents: Vec::new(), host: host_identity(&sidecar) })
}

/// Build an unsaved lane-editor draft from a session's model selection.
///
/// This command never writes the source file; the caller must continue through
/// preview_omp_lanes and save_omp_lanes for validation and explicit confirmation.
#[tauri::command]
pub fn prepare_omp_lane_model_change(
    repo_path: String,
    lane_key: String,
    model: String,
) -> Result<Vec<OmpLaneEntry>, String> {
    let _lock = RoutingLock::acquire()?;
    if model.trim().is_empty() {
        return Err("model must not be empty".into());
    }
    let repo = PathBuf::from(repo_path);
    let (_sidecar, repo) = read_sidecar(Some(&repo))?;
    let path = lanes_path(&repo);
    let source: Value = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("invalid lanes.json: {e}"))?;
    let mut lanes = lane_entries(&source)?;
    for lane in &mut lanes {
        lane.used_by = lane_usage(&repo, &lane.key)?;
    }
    let lane = lanes.iter_mut().find(|lane| lane.key == lane_key)
        .ok_or_else(|| format!("unknown lane: {lane_key}"))?;
    lane.model = model;
    lane.alias_of = lane.model.strip_prefix('@').map(str::to_string);
    Ok(lanes)
}

#[tauri::command]
pub fn save_omp_lanes(repo_path: String, lanes: Vec<OmpLaneEntry>, revision: String) -> Result<OmpLaneSaveOutcome, String> {
    let _lock = RoutingLock::acquire()?;
    let repo = PathBuf::from(repo_path);
    let (sidecar, repo) = read_sidecar(Some(&repo))?;
    let config_root = PathBuf::from(&sidecar.host.config_root);
    let path = lanes_path(&repo);
    let before = fs::read(&path).map_err(|e| e.to_string())?;
    if hash(&before) != revision { return Err("stale_source: lanes.json changed after preview".into()); }
    let candidate = render_lanes(&lanes)?;
    let tmp = temp_path(&repo, "save");
    fs::write(&tmp, &candidate).map_err(|e| e.to_string())?;
    let problems = validate_candidate(&repo, &tmp);
    if !problems.is_empty() { let _ = fs::remove_file(&tmp); return Err(serde_json::to_string(&problems).unwrap_or_else(|_| "lane validation failed".into())); }
    fs::rename(&tmp, &path).map_err(|e| format!("cannot replace lanes.json: {e}"))?;
    let runner = repo.join("profiles/install.sh");
    let started = Instant::now();
    let output = run_capture_env(
        Path::new("sh"),
        &[runner.to_str().ok_or("invalid install path")?, "--models-only"],
        Some(&repo),
        SAVE_TIMEOUT,
        &[("OH_MY_BUZZ_LOCK_HELD", "1")],
    );
    let exe = PathBuf::from(&sidecar.host.executable);
    let (code, stdout, stderr, timed_out) = match output { Ok(v) => v, Err(e) => (127, String::new(), e, false) };
    let profile_names = ["default", "orchestrator", "planner", "coder", "reviewer", "scout", "designer"];
    let mut profiles = Vec::with_capacity(profile_names.len());
    let mut records = Vec::with_capacity(profile_names.len() * 2);
    let mut backups = None;
    for profile in profile_names {
        if let Some(path) = stdout.lines().find_map(|line| line.strip_prefix("  backup ")) {
            backups = Some(path.to_string());
        }
        let reached = stdout.lines().any(|line| line.contains(&format!("{profile}: model roles and task-agent selections synchronized")))
            || stdout.lines().any(|line| line.contains(&format!("{profile}: model settings already current")));
        if reached {
            let (profile_state, record_states) = verify_profile_records(&exe, &config_root, &repo, profile);
            profiles.push(profile_state);
            records.extend(record_states);
        } else {
            let failed_profile = profile_names.iter().find(|name| stderr.contains(&format!("FAIL  {name}:"))).copied();
            let is_failed = failed_profile == Some(profile);
            let state = if is_failed { "failed" } else { "unknown" };
            let detail = if is_failed { "installer reported failure for this profile" } else { "installer did not report completing this profile" };
            profiles.push(OmpProfileApplyState { profile: profile.into(), state: state.into(), detail: Some(detail.into()) });
            records.extend(["modelRoles", "task.agentModelOverrides"].iter().map(|record| OmpRecordApplyState {
                profile: profile.into(), record: (*record).into(), state: state.into(), detail: Some(detail.into()),
            }));
        }
    }
    let incomplete = code != 0 || timed_out || profiles.iter().any(|profile| profile.state != "applied");
    let recovery = if incomplete {
        vec![format!("Previous configuration backup: {}. After correcting the reported failure, run sh {} --models-only to retry; the source file remains written.", backups.as_deref().unwrap_or("no backup was reported"), runner.display())]
    } else { Vec::new() };
    Ok(OmpLaneSaveOutcome { source: "written".into(), profiles, records, backups, recovery, stdout, stderr, timed_out, duration_ms: started.elapsed().as_millis() as u64 })
}

fn refusal(code: &str, output: String, branch: Option<String>) -> OmpLaneCommitOutcome {
    OmpLaneCommitOutcome { committed: false, sha: None, branch, refused: Some(code.into()), output }
}

#[tauri::command]
pub fn get_omp_lane_repo_status(repo_path: String) -> Result<OmpLaneRepoStatus, String> {
    let repo = PathBuf::from(repo_path);
    let path = lanes_path(&repo);
    let revision = fs::read(&path).ok().map(|bytes| hash(&bytes));
    let output = Command::new("git").args(["status", "--porcelain=v1", "--", "profiles/lanes.json"]).current_dir(&repo).output();
    let (git_present, lanes_dirty, head) = match output {
        Ok(status) if status.status.success() => {
            let text = String::from_utf8_lossy(&status.stdout).to_string();
            let head = Command::new("git").args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(&repo).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().into());
            (true, !text.trim().is_empty(), head)
        }
        _ => (false, false, None),
    };
    let unrelated_dirty_paths = if git_present {
        status_paths(&repo).into_iter().filter(|path| path != "profiles/lanes.json").collect()
    } else { Vec::new() };
    Ok(OmpLaneRepoStatus { git_present, lanes_dirty, lanes_revision: revision, unrelated_dirty_paths, head })
}
fn status_paths(repo: &Path) -> Vec<String> {
    let Ok(output) = Command::new("git").args(["status", "--porcelain=v1"]).current_dir(repo).output() else { return Vec::new(); };
    if !output.status.success() { return Vec::new(); }
    String::from_utf8_lossy(&output.stdout).lines().filter_map(|line| {
        line.get(3..).map(str::trim).filter(|path| !path.is_empty()).map(str::to_string)
    }).collect()
}

#[tauri::command]
pub fn commit_omp_lanes(repo_path: String, revision: String) -> Result<OmpLaneCommitOutcome, String> {
    let _lock = RoutingLock::acquire()?;
    let repo = PathBuf::from(repo_path);
    let path = lanes_path(&repo);
    let current = fs::read(&path).map_err(|e| e.to_string())?;
    if hash(&current) != revision {
        return Ok(refusal("revision_changed", "lanes.json changed".into(), None));
    }
    let in_repo = Command::new("git").args(["rev-parse", "--is-inside-work-tree"]).current_dir(&repo).output();
    if !in_repo.as_ref().is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true") {
        return Ok(refusal("not_a_repo", "repository is not a git work tree".into(), None));
    }
    let branch = Command::new("git").args(["branch", "--show-current"]).current_dir(&repo).output().map_err(|e| e.to_string())?;
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();
    if branch.is_empty() { return Ok(refusal("detached_head", "HEAD is detached".into(), None)); }
    for (git_path, code) in [("MERGE_HEAD", "merge_in_progress"), ("rebase-merge", "rebase_in_progress"), ("rebase-apply", "rebase_in_progress"), ("CHERRY_PICK_HEAD", "cherry_pick_in_progress")] {
        let resolved = Command::new("git").args(["rev-parse", "--git-path", git_path]).current_dir(&repo).output().map_err(|e| e.to_string())?;
        let marker = PathBuf::from(String::from_utf8_lossy(&resolved.stdout).trim());
        if marker.exists() { return Ok(refusal(code, format!("git operation in progress: {git_path}"), Some(branch))); }
    }
    let status = Command::new("git").args(["diff", "--cached", "--name-only"]).current_dir(&repo).output().map_err(|e| e.to_string())?;
    if !status.status.success() { return Ok(refusal("not_a_repo", String::from_utf8_lossy(&status.stderr).into_owned(), Some(branch))); }
    let staged = String::from_utf8_lossy(&status.stdout);
    if staged.lines().any(|line| line != "profiles/lanes.json") {
        return Ok(refusal("unrelated_staged_changes", staged.into(), Some(branch)));
    }
    let add = Command::new("git").args(["add", "--", "profiles/lanes.json"]).current_dir(&repo).output().map_err(|e| e.to_string())?;
    if !add.status.success() { return Err(String::from_utf8_lossy(&add.stderr).into()); }
    let commit = Command::new("git").args(["commit", "-m", "chore(routing): update lanes from Buzz", "--", "profiles/lanes.json"]).current_dir(&repo).output().map_err(|e| e.to_string())?;
    let output = format!("{}{}", String::from_utf8_lossy(&commit.stdout), String::from_utf8_lossy(&commit.stderr));
    if !commit.status.success() {
        let refused = if output.contains("Author identity unknown") || output.contains("user.name") || output.contains("user.email") {
            "identity_unresolved"
        } else {
            "hook_failed"
        };
        return Ok(OmpLaneCommitOutcome { committed: false, sha: None, branch: Some(branch), refused: Some(refused.into()), output });
    }
    let sha = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&repo).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().into());
    let branch = Command::new("git").args(["branch", "--show-current"]).current_dir(&repo).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().into());
    Ok(OmpLaneCommitOutcome { committed: true, sha, branch, refused: None, output })
}
