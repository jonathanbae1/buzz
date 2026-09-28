use super::project_git::first_output_line;
use super::project_git_types::ProjectLocalRepoDocument;
use super::project_git_exec::{
    build_git_auth_config, clean_branch, clean_target_ref, run_git, validate_workspace_clone_url,
    GitAuthConfig,
};
use super::project_repo_paths::find_local_repo_dir;
use crate::app_state::AppState;
use tauri::State;

const MAX_PREVIEW_BYTES: u64 = 64 * 1024;

/// Why a file could not be read, in the caller's terms.
///
/// The reader distinguishes three outcomes so a page that is merely missing,
/// a page that is too large to preview, and a page on disk cannot all collapse
/// into `null`. `MAX_PREVIEW_BYTES` is a real ceiling, so "too large" is an
/// honest answer rather than a transient failure.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PreviewProblem {
    /// No such path inside the checkout.
    NotFound,
    /// Present but refused: too large, a symlink, a directory, or non-UTF-8.
    Unavailable(&'static str),
}

pub(crate) fn read_preview_content(
    repo_dir: &std::path::Path,
    path: &str,
    size: Option<u64>,
) -> Option<String> {
    match read_preview_file(repo_dir, path, size) {
        Ok(content) => Some(content),
        Err(_) => None,
    }
}

/// Read one file from a checkout, refusing anything that escapes the root.
///
/// Every refusal carries its reason. Callers that only need a best-effort
/// `Option<String>` go through [`read_preview_content`]; callers that must
/// label an unreadable file distinctly use this directly.
pub(crate) fn read_preview_file(
    repo_dir: &std::path::Path,
    path: &str,
    size: Option<u64>,
) -> Result<String, PreviewProblem> {
    if size.is_some_and(|value| value > MAX_PREVIEW_BYTES) {
        return Err(PreviewProblem::Unavailable("file exceeds the preview size"));
    }

    let full_path = repo_dir.join(path);
    if !full_path.exists() {
        return Err(PreviewProblem::NotFound);
    }
    if std::fs::symlink_metadata(&full_path)
        .map_err(|_| PreviewProblem::NotFound)?
        .file_type()
        .is_symlink()
    {
        return Err(PreviewProblem::Unavailable("symlinks are not previewed"));
    }
    let normalized = full_path
        .canonicalize()
        .map_err(|_| PreviewProblem::NotFound)?;
    let repo_root = repo_dir
        .canonicalize()
        .map_err(|_| PreviewProblem::NotFound)?;
    if !normalized.starts_with(repo_root) {
        return Err(PreviewProblem::Unavailable(
            "path escapes the checkout root",
        ));
    }

    let metadata = std::fs::metadata(&normalized).map_err(|_| PreviewProblem::NotFound)?;
    if !metadata.is_file() {
        return Err(PreviewProblem::Unavailable("not a regular file"));
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(PreviewProblem::Unavailable("file exceeds the preview size"));
    }
    let bytes = std::fs::read(normalized).map_err(|_| PreviewProblem::NotFound)?;
    if bytes.contains(&0) {
        return Err(PreviewProblem::Unavailable("binary file"));
    }
    String::from_utf8(bytes).map_err(|_| PreviewProblem::Unavailable("file is not UTF-8"))
}

pub(crate) fn validate_repo_file_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || std::path::Path::new(path)
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Repository file path must be a relative file path.".to_string());
    }
    Ok(())
}

pub(crate) fn checkout_project_repo(
    repo_dir: &std::path::Path,
    clone_url: &str,
    branch: Option<&str>,
    target_ref: Option<&str>,
    target_commit: Option<&str>,
    auth: &GitAuthConfig,
) -> Result<(), String> {
    let repo_path = repo_dir
        .to_str()
        .ok_or_else(|| "temporary repository path is not UTF-8".to_string())?;
    let explicit_target = target_ref.or(target_commit);

    if let Some(fetch_ref) = explicit_target {
        run_git(
            &[
                "clone",
                "--filter=blob:none",
                "--no-checkout",
                clone_url,
                repo_path,
            ],
            None,
            auth,
        )?;
        run_git(
            &["fetch", "--depth=100", "origin", fetch_ref],
            Some(repo_dir),
            auth,
        )?;
        if let Some(expected_commit) = target_commit {
            let fetched_commit = run_git(&["rev-parse", "FETCH_HEAD"], Some(repo_dir), auth)
                .ok()
                .and_then(|output| first_output_line(&output))
                .map(|commit| commit.to_ascii_lowercase())
                .ok_or_else(|| "Could not resolve the requested repository ref.".to_string())?;
            if fetched_commit != expected_commit {
                return Err(
                    "The requested repository ref changed. Refresh and try again.".to_string(),
                );
            }
        }
        run_git(
            &["checkout", "--detach", "FETCH_HEAD"],
            Some(repo_dir),
            auth,
        )?;
        return Ok(());
    }

    let mut clone_args = vec!["clone", "--filter=blob:none"];
    if let Some(branch) = branch {
        clone_args.push("--branch");
        clone_args.push(branch);
    }
    clone_args.push(clone_url);
    clone_args.push(repo_path);
    if run_git(&clone_args, None, auth).is_err() && branch.is_some() {
        run_git(
            &["clone", "--filter=blob:none", clone_url, repo_path],
            None,
            auth,
        )?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_project_repo_file_content(
    clone_url: String,
    default_branch: Option<String>,
    target_ref: Option<String>,
    target_commit: Option<String>,
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    validate_workspace_clone_url(&clone_url, &state)?;
    validate_repo_file_path(&path)?;
    let auth = build_git_auth_config(&state)?;
    let branch = clean_branch(default_branch);
    let target_ref = clean_target_ref(target_ref);
    let target_commit = target_commit
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| matches!(value.len(), 40 | 64))
        .filter(|value| value.chars().all(|c| c.is_ascii_hexdigit()));

    tauri::async_runtime::spawn_blocking(move || {
        let temp_dir = tempfile::tempdir().map_err(|error| format!("create temp dir: {error}"))?;
        let repo_dir = temp_dir.path().join("repo");
        checkout_project_repo(
            &repo_dir,
            &clone_url,
            branch.as_deref(),
            target_ref.as_deref(),
            target_commit.as_deref(),
            &auth,
        )?;
        Ok(read_preview_content(&repo_dir, &path, None))
    })
    .await
    .map_err(|error| format!("repo file content task failed: {error}"))?
}

#[tauri::command]
pub async fn get_project_local_repo_file_content(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: Option<String>,
    path: String,
) -> Result<Option<String>, String> {
    validate_repo_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(repo_dir) =
            find_local_repo_dir(repos_dir.as_deref(), &project_dtag, clone_url.as_deref())?
        else {
            return Ok(None);
        };
        Ok(read_preview_content(&repo_dir, &path, None))
    })
    .await
    .map_err(|error| format!("local repo file content task failed: {error}"))?
}

/// Read one file from a local checkout, reporting *why* it is unavailable.
///
/// `get_project_local_repo_file_content` collapses every refusal into `null`,
/// which a reader cannot distinguish from "this file does not exist". A
/// collection that must label an oversized or non-UTF-8 document as **not
/// covered by search** needs the distinction, so this is the same reader with
/// its reason preserved.
#[tauri::command]
pub async fn get_project_local_repo_document_content(
    repos_dir: Option<String>,
    project_dtag: String,
    clone_url: Option<String>,
    path: String,
) -> Result<ProjectLocalRepoDocument, String> {
    validate_repo_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo_dir = find_local_repo_dir(repos_dir.as_deref(), &project_dtag, clone_url.as_deref())?
            .ok_or_else(|| "No local checkout found for this repository.".to_string())?;
        Ok(match read_preview_file(&repo_dir, &path, None) {
            Ok(content) => ProjectLocalRepoDocument {
                path,
                content: Some(content),
                unavailable_reason: None,
            },
            Err(PreviewProblem::NotFound) => ProjectLocalRepoDocument {
                path,
                content: None,
                unavailable_reason: Some("file was not found in the checkout".to_string()),
            },
            Err(PreviewProblem::Unavailable(reason)) => ProjectLocalRepoDocument {
                path,
                content: None,
                unavailable_reason: Some(reason.to_string()),
            },
        })
    })
    .await
    .map_err(|error| format!("local repo document task failed: {error}"))?
}
