//! Tauri entry points for the lane editor.
//!
//! Tauri runs synchronous commands on the main thread, so each blocking store,
//! file, git or installer call in `omp_lanes` is dispatched to the blocking
//! pool; otherwise a save (which runs the profile installer, up to 60 s) or a
//! catalog read freezes the whole window.

use super::omp_lanes::*;

#[tauri::command]
pub async fn get_omp_lane_editor_state() -> OmpLaneEditorState {
    tauri::async_runtime::spawn_blocking(get_omp_lane_editor_state_blocking)
        .await
        .unwrap_or_else(|error| panic!("get_omp_lane_editor_state worker failed: {error}"))
}

#[tauri::command]
pub async fn get_omp_model_catalog(repo_path: String) -> Result<OmpModelCatalog, String> {
    tauri::async_runtime::spawn_blocking(move || get_omp_model_catalog_blocking(repo_path))
        .await
        .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}

#[tauri::command]
pub async fn preview_omp_lanes(
    repo_path: String,
    lanes: Vec<OmpLaneEntry>,
) -> Result<OmpLanePreview, String> {
    tauri::async_runtime::spawn_blocking(move || preview_omp_lanes_blocking(repo_path, lanes))
        .await
        .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}

#[tauri::command]
pub async fn prepare_omp_lane_model_change(
    repo_path: String,
    lane_key: String,
    model: String,
) -> Result<Vec<OmpLaneEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        prepare_omp_lane_model_change_blocking(repo_path, lane_key, model)
    })
    .await
    .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}

#[tauri::command]
pub async fn save_omp_lanes(
    repo_path: String,
    lanes: Vec<OmpLaneEntry>,
    revision: String,
) -> Result<OmpLaneSaveOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_omp_lanes_blocking(repo_path, lanes, revision)
    })
    .await
    .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}

#[tauri::command]
pub async fn get_omp_lane_repo_status(repo_path: String) -> Result<OmpLaneRepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || get_omp_lane_repo_status_blocking(repo_path))
        .await
        .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}

#[tauri::command]
pub async fn commit_omp_lanes(
    repo_path: String,
    revision: String,
) -> Result<OmpLaneCommitOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || commit_omp_lanes_blocking(repo_path, revision))
        .await
        .unwrap_or_else(|error| Err(format!("lane worker failed: {error}")))
}
