//! Model-pack import: converts the user's locally purchased Synth files
//! (FBX + PSD textures) into a loadable pack in the app-data dir, using the
//! embedded Python runtime and the pipeline scripts/specs/manifests shipped
//! under `resources/`. See `resources/README.md` for how those are produced.
//!
//! The command handlers at the bottom are thin; everything testable lives in
//! plain functions that take explicit paths.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

/// Step labels are human-readable; the wizard renders them as a checklist.
const STEPS: [(&str, &str); 10] = [
    ("prepare", "Preparing pack folder"),
    ("model", "Copying model (FBX)"),
    ("manifest", "Writing pack manifest"),
    ("masks-main", "Extracting body/eye masks from main PSD"),
    ("masks-clothing", "Extracting clothing masks from clothing PSD"),
    ("pack", "Packing mask channels"),
    ("bake-body", "Baking body albedo (large PSD — this can take a few minutes)"),
    ("bake-clothing", "Baking clothing albedo"),
    ("colors", "Merging sampled default colors into manifest"),
    ("cleanup", "Removing pipeline intermediates"),
];

#[derive(Serialize, Clone)]
pub struct ImportedPack {
    pub id: String,
    pub name: String,
    /// Absolute path of the pack directory (contains manifest.json).
    pub path: String,
}

#[derive(Serialize, Clone)]
pub struct ProgressEvent {
    pub step: String,
    pub label: String,
    /// "running" | "done"
    pub status: String,
    /// 1-based position within STEPS (for "Step X of N" and progress bars).
    pub index: u32,
    pub total: u32,
}

#[derive(Serialize, Clone, Default)]
pub struct ScanResult {
    pub fbx: Option<String>,
    pub main_psd: Option<String>,
    pub clothing_psd: Option<String>,
    /// Every candidate found, sorted — the wizard offers them as fallbacks.
    pub fbx_candidates: Vec<String>,
    pub psd_candidates: Vec<String>,
}

pub struct ImportOptions {
    pub variant: String,
    pub fbx_path: PathBuf,
    pub main_psd_path: PathBuf,
    pub clothing_psd_path: PathBuf,
    /// The bundled `resources/` dir (contains python/, pipeline/, packs/).
    pub resource_root: PathBuf,
    /// Destination pack dir, `<app_data>/packs/zairiza-synth-<variant>`.
    pub pack_dir: PathBuf,
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested, no Tauri handles involved)
// ---------------------------------------------------------------------------

/// Scan `<packs_dir>/*/manifest.json` for importable packs. Invalid or
/// incomplete entries are skipped silently — a half-written pack must not
/// break listing.
pub fn scan_packs_dir(packs_dir: &Path) -> Vec<ImportedPack> {
    let mut packs = Vec::new();
    let Ok(entries) = fs::read_dir(packs_dir) else {
        return packs;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        let Ok(text) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let (Some(id), Some(name)) = (
            value.get("id").and_then(Value::as_str),
            value.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        packs.push(ImportedPack {
            id: id.to_string(),
            name: name.to_string(),
            path: dir.to_string_lossy().to_string(),
        });
    }
    packs.sort_by(|a, b| a.id.cmp(&b.id));
    packs
}

/// First candidate that looks like our bundled `resources/` dir. In
/// production resources sit next to the exe under `resources/`; in dev the
/// exe lives in `target/<profile>` and the dir is `src-tauri/resources` —
/// the caller passes both kinds of candidates.
pub fn pick_resource_root(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|dir| {
            dir.join("pipeline").join("extract_textures.py").is_file()
                && dir.join("python").join("python.exe").is_file()
                && dir
                    .join("packs")
                    .join("zairiza-synth-sfw")
                    .join("manifest.json")
                    .is_file()
        })
        .cloned()
}

/// Write bake_shading's sampled reference colors ({regionId: "#hex"}) back
/// into the manifest as each region's `defaultColor`. Only ids present in
/// the map are touched (emissive regions are never sampled by the bake).
pub fn merge_default_colors(manifest: &mut Value, colors: &serde_json::Map<String, Value>) -> usize {
    let mut applied = 0;
    for key in ["colorRegions", "emissiveRegions"] {
        let Some(regions) = manifest.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for region in regions.iter_mut() {
            let Some(obj) = region.as_object_mut() else {
                continue;
            };
            let Some(id) = obj.get("id").and_then(Value::as_str).map(str::to_owned) else {
                continue;
            };
            if let Some(color) = colors.get(&id).and_then(Value::as_str) {
                obj.insert("defaultColor".to_string(), Value::String(color.to_string()));
                applied += 1;
            }
        }
    }
    applied
}

fn normalize_seps(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Walk `root` (depth-limited, entry-capped) collecting .fbx/.psd files,
/// then pick the model FBX and the main/clothing PSDs by known layout and
/// name heuristics. Anything ambiguous is left `None` for manual picking.
pub fn scan_model_folder_inner(root: &Path, variant: &str) -> ScanResult {
    let mut fbxs: Vec<PathBuf> = Vec::new();
    let mut psds: Vec<PathBuf> = Vec::new();
    let mut visited: usize = 0;
    collect_media(root, 0, &mut visited, &mut fbxs, &mut psds);
    fbxs.sort();
    psds.sort();

    let variant_word = variant.to_lowercase(); // "sfw" | "nsfw"
    let known_fbx = format!("{variant_word}/fbx/synth{}.fbx", if variant_word == "nsfw" { " nsfw all" } else { "" });

    let fbx = fbxs
        .iter()
        .find(|p| relative_normalized(root, p) == known_fbx)
        .or_else(|| {
            fbxs.iter()
                .find(|p| normalize_seps(p).contains("/fbx/") && normalize_seps(p).contains(&variant_word))
        })
        .or_else(|| fbxs.iter().find(|p| normalize_seps(p).contains(&variant_word)))
        .or_else(|| fbxs.first());

    // PSDs living under a Textures/PSDs dir are preferred; the variant's own
    // subtree wins over the other variant's.
    let preferred_psds: Vec<&PathBuf> = {
        let mut v: Vec<&PathBuf> = psds
            .iter()
            .filter(|p| normalize_seps(p).contains("/textures/psds/") && normalize_seps(p).contains(&variant_word))
            .collect();
        if v.is_empty() {
            v = psds
                .iter()
                .filter(|p| normalize_seps(p).contains("/textures/psds/"))
                .collect();
        }
        if v.is_empty() {
            v = psds.iter().collect();
        }
        v
    };
    let name_is = |p: &PathBuf, needle: &str| {
        p.file_name()
            .map(|n| n.to_string_lossy().to_lowercase().contains(needle))
            .unwrap_or(false)
    };
    let clothing_psd = preferred_psds.iter().find(|p| name_is(p, "cloth")).copied();
    let main_psd = preferred_psds
        .iter()
        .find(|p| name_is(p, "main"))
        .or_else(|| preferred_psds.iter().find(|p| name_is(p, "body")))
        .copied();
    // Exactly one unmatched leftover is safe to assign to the other slot.
    let (main_psd, clothing_psd) = match (main_psd, clothing_psd) {
        (Some(m), None) if preferred_psds.len() == 2 => (
            Some(m),
            preferred_psds.iter().find(|p| ***p != *m).copied(),
        ),
        (None, Some(c)) if preferred_psds.len() == 2 => (
            preferred_psds.iter().find(|p| ***p != *c).copied(),
            Some(c),
        ),
        pair => pair,
    };

    ScanResult {
        fbx: fbx.map(|p| p.to_string_lossy().to_string()),
        main_psd: main_psd.map(|p| p.to_string_lossy().to_string()),
        clothing_psd: clothing_psd.map(|p| p.to_string_lossy().to_string()),
        fbx_candidates: fbxs.iter().map(|p| p.to_string_lossy().to_string()).collect(),
        psd_candidates: psds.iter().map(|p| p.to_string_lossy().to_string()).collect(),
    }
}

fn relative_normalized(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(normalize_seps_path)
        .unwrap_or_else(|_| normalize_seps(path))
}

fn normalize_seps_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_lowercase()
}

const MAX_SCAN_DEPTH: usize = 6;
const MAX_SCAN_ENTRIES: usize = 50_000;

fn collect_media(dir: &Path, depth: usize, visited: &mut usize, fbxs: &mut Vec<PathBuf>, psds: &mut Vec<PathBuf>) {
    if depth > MAX_SCAN_DEPTH || *visited >= MAX_SCAN_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        *visited += 1;
        if *visited >= MAX_SCAN_ENTRIES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_media(&path, depth + 1, visited, fbxs, psds);
        } else if name.ends_with(".fbx") {
            fbxs.push(path);
        } else if name.ends_with(".psd") {
            psds.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Import runner
// ---------------------------------------------------------------------------

fn step_label(step: &str) -> &str {
    STEPS
        .iter()
        .find(|(id, _)| *id == step)
        .map(|(_, label)| *label)
        .unwrap_or(step)
}

/// Run one pipeline script under the embedded Python; non-zero exits bubble
/// up with the stderr tail.
fn run_python(python: &Path, script: &Path, args: &[&OsStr], step: &str) -> Result<(), String> {
    let mut command = Command::new(python);
    command
        .arg(script)
        .args(args)
        .env("PYTHONUTF8", "1")
        // The resources dir is read-only once installed; don't even try
        // writing .pyc caches there.
        .env("PYTHONDONTWRITEBYTECODE", "1");
    // The app is a GUI-subsystem binary; keep python's console from flashing.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("{}: failed to launch {}: {e}", step_label(step), python.display()))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let tail: String = stderr.chars().skip(stderr.chars().count().saturating_sub(2000)).collect();
    Err(format!(
        "{} failed ({}): {}",
        step_label(step),
        output.status,
        tail.trim()
    ))
}

fn copy_step(from: &Path, to: &Path, what: &str) -> Result<(), String> {
    fs::copy(from, to).map_err(|e| format!("failed to copy {what} to {}: {e}", to.display()))?;
    Ok(())
}

/// Full conversion. Emits a running/done ProgressEvent per step through
/// `progress`. On failure the half-built pack dir is removed so a broken
/// pack never shows up in `list_imported_packs`.
pub fn run_import_inner(opts: &ImportOptions, progress: &dyn Fn(ProgressEvent)) -> Result<(), String> {
    let result = run_import_steps(opts, progress);
    if result.is_err() && opts.pack_dir.is_dir() {
        let _ = fs::remove_dir_all(&opts.pack_dir);
    }
    result
}

fn run_import_steps(opts: &ImportOptions, progress: &dyn Fn(ProgressEvent)) -> Result<(), String> {
    let emit = |step: &str, status: &str| {
        let index = STEPS
            .iter()
            .position(|(id, _)| id == &step)
            .map(|p| p as u32 + 1)
            .unwrap_or(0);
        progress(ProgressEvent {
            step: step.to_string(),
            label: step_label(step).to_string(),
            status: status.to_string(),
            index,
            total: STEPS.len() as u32,
        });
    };

    // ---- validate everything before touching the destination -------------
    let spec_dir_name = match opts.variant.as_str() {
        "sfw" => "zairiza-synth",
        "nsfw" => "zairiza-synth-nsfw",
        other => return Err(format!("unknown variant \"{other}\" (expected sfw|nsfw)")),
    };
    for (path, what) in [
        (&opts.fbx_path, "model FBX"),
        (&opts.main_psd_path, "main PSD"),
        (&opts.clothing_psd_path, "clothing PSD"),
    ] {
        if !path.is_file() {
            return Err(format!("{what} not found: {}", path.display()));
        }
    }
    // Variant/file consistency: the NSFW package names every file with an
    // "NSFW" marker, the SFW one never does. Catches the classic mistake of
    // importing NSFW files under the SFW variant (or vice versa) with a clear
    // message instead of a downstream "layer not found in PSD" wall of text.
    for (path, what) in [
        (&opts.fbx_path, "model FBX"),
        (&opts.main_psd_path, "main PSD"),
        (&opts.clothing_psd_path, "clothing PSD"),
    ] {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if opts.variant == "sfw" && name.contains("nsfw") {
            return Err(format!(
                "variant/file mismatch: {what} \"{}\" looks like an NSFW file, but the SFW variant was selected. \
                 Either pick the SFW files or switch the variant to NSFW.",
                path.display()
            ));
        }
    }
    let resource = &opts.resource_root;
    let python = resource.join("python").join("python.exe");
    let script_dir = resource.join("pipeline");
    let spec_dir = script_dir.join("specs").join(spec_dir_name);
    let main_mask_spec = spec_dir.join("main_masks.json");
    // The NSFW spec dir has no clothing spec of its own — the clothing PSD
    // layers are the same, so fall back to the shared SFW clothing spec.
    let clothing_mask_spec = {
        let own = spec_dir.join("clothing_masks.json");
        if own.is_file() {
            own
        } else {
            script_dir
                .join("specs")
                .join("zairiza-synth")
                .join("clothing_masks.json")
        }
    };
    let packing_spec = spec_dir.join("mask_packing.json");
    let master_manifest = resource
        .join("packs")
        .join(format!("zairiza-synth-{}", opts.variant))
        .join("manifest.json");
    for (path, what) in [
        (&python, "embedded Python"),
        (&main_mask_spec, "main mask spec"),
        (&clothing_mask_spec, "clothing mask spec"),
        (&packing_spec, "mask packing spec"),
        (&master_manifest, "master manifest"),
    ] {
        if !path.is_file() {
            return Err(format!("bundled {what} missing: {}", path.display()));
        }
    }

    let pack = &opts.pack_dir;
    let textures = pack.join("textures");
    let manifest_path = pack.join("manifest.json");

    // ---- 1. fresh pack dir -------------------------------------------------
    emit("prepare", "running");
    if pack.exists() {
        fs::remove_dir_all(pack).map_err(|e| format!("failed to clear {}: {e}", pack.display()))?;
    }
    fs::create_dir_all(&textures).map_err(|e| format!("failed to create {}: {e}", textures.display()))?;
    emit("prepare", "done");

    // ---- 2. model ----------------------------------------------------------
    emit("model", "running");
    copy_step(&opts.fbx_path, &pack.join("model.fbx"), "model FBX")?;
    emit("model", "done");

    // ---- 3. manifest (model field rewritten to the FBX) --------------------
    emit("manifest", "running");
    let manifest_text = fs::read_to_string(&master_manifest)
        .map_err(|e| format!("failed to read {}: {e}", master_manifest.display()))?;
    let mut manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|e| format!("master manifest is not valid JSON: {e}"))?;
    manifest["model"] = Value::String("model.fbx".to_string());
    let manifest_out = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("failed to serialize manifest: {e}"))?;
    fs::write(&manifest_path, manifest_out)
        .map_err(|e| format!("failed to write {}: {e}", manifest_path.display()))?;
    emit("manifest", "done");

    // ---- 4. masks from both PSDs into <pack>/textures/masks ----------------
    let extract = script_dir.join("extract_textures.py");
    emit("masks-main", "running");
    run_python(
        &python,
        &extract,
        &[
            OsStr::new("--mask"),
            opts.main_psd_path.as_os_str(),
            OsStr::new("--spec"),
            main_mask_spec.as_os_str(),
            OsStr::new("--out"),
            textures.as_os_str(),
        ],
        "masks-main",
    )?;
    emit("masks-main", "done");

    emit("masks-clothing", "running");
    run_python(
        &python,
        &extract,
        &[
            OsStr::new("--mask"),
            opts.clothing_psd_path.as_os_str(),
            OsStr::new("--spec"),
            clothing_mask_spec.as_os_str(),
            OsStr::new("--out"),
            textures.as_os_str(),
        ],
        "masks-clothing",
    )?;
    emit("masks-clothing", "done");

    // ---- 5. pack grayscale masks into RGBA channels -------------------------
    emit("pack", "running");
    run_python(
        &python,
        &script_dir.join("pack_masks.py"),
        &[
            textures.join("masks").as_os_str(),
            OsStr::new("--spec"),
            packing_spec.as_os_str(),
            OsStr::new("--out"),
            textures.join("packed").as_os_str(),
            OsStr::new("--dilate"),
            OsStr::new("9"),
        ],
        "pack",
    )?;
    emit("pack", "done");

    // ---- 6. bake shading albedos (+ sample default colors) ------------------
    let bake = script_dir.join("bake_shading.py");
    let body_colors_path = pack.join(".import-body-colors.json");
    let clothing_colors_path = pack.join(".import-clothing-colors.json");
    for (step, psd, materials, out_png, colors_path) in [
        (
            "bake-body",
            &opts.main_psd_path,
            "body,eyes",
            "body_albedo.png",
            &body_colors_path,
        ),
        (
            "bake-clothing",
            &opts.clothing_psd_path,
            "clothing",
            "clothing_albedo.png",
            &clothing_colors_path,
        ),
    ] {
        emit(step, "running");
        run_python(
            &python,
            &bake,
            &[
                OsStr::new("--psd"),
                psd.as_os_str(),
                OsStr::new("--packed"),
                textures.join("packed").as_os_str(),
                OsStr::new("--spec"),
                packing_spec.as_os_str(),
                OsStr::new("--manifest"),
                manifest_path.as_os_str(),
                OsStr::new("--only-material"),
                OsStr::new(materials),
                OsStr::new("--out"),
                textures.join(out_png).as_os_str(),
                OsStr::new("--colors-out"),
                colors_path.as_os_str(),
            ],
            step,
        )?;
        emit(step, "done");
    }

    // ---- 7. sampled colors -> manifest defaultColor -------------------------
    emit("colors", "running");
    let mut applied = 0;
    for colors_path in [&body_colors_path, &clothing_colors_path] {
        let text = fs::read_to_string(colors_path)
            .map_err(|e| format!("failed to read {}: {e}", colors_path.display()))?;
        let colors = serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("{} is not valid JSON: {e}", colors_path.display()))?;
        if let Some(map) = colors.as_object() {
            applied += merge_default_colors(&mut manifest, map);
        }
    }
    if applied == 0 {
        return Err("no sampled colors matched manifest regions".to_string());
    }
    let manifest_out = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("failed to serialize manifest: {e}"))?;
    fs::write(&manifest_path, manifest_out)
        .map_err(|e| format!("failed to write {}: {e}", manifest_path.display()))?;
    emit("colors", "done");

    // ---- 8. trim pipeline-only intermediates --------------------------------
    emit("cleanup", "running");
    let masks_dir = textures.join("masks");
    if masks_dir.is_dir() {
        fs::remove_dir_all(&masks_dir)
            .map_err(|e| format!("failed to remove {}: {e}", masks_dir.display()))?;
    }
    for tmp in [&body_colors_path, &clothing_colors_path] {
        if tmp.is_file() {
            let _ = fs::remove_file(tmp);
        }
    }
    emit("cleanup", "done");

    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Bundled `resources/` dir, resolved for both dev and installed layouts.
fn resource_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("resources"));
        candidates.push(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(6) {
            candidates.push(ancestor.join("resources"));
        }
    }
    pick_resource_root(&candidates).ok_or_else(|| {
        format!(
            "bundled resources not found (looked in: {})",
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        )
    })
}

fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("packs"))
        .map_err(|e| format!("app data dir unavailable: {e}"))
}

/// Imported packs found under `<app_data>/packs/*/manifest.json`.
#[tauri::command]
pub fn list_imported_packs(app: AppHandle) -> Result<Vec<ImportedPack>, String> {
    Ok(scan_packs_dir(&packs_dir(&app)?))
}

/// Auto-find the model FBX and main/clothing PSDs inside the folder the
/// user pointed at (their purchased model directory).
#[tauri::command]
pub fn scan_model_folder(folder: String, variant: String) -> Result<ScanResult, String> {
    match variant.as_str() {
        "sfw" | "nsfw" => {}
        other => return Err(format!("unknown variant \"{other}\" (expected sfw|nsfw)")),
    }
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("not a folder: {folder}"));
    }
    Ok(scan_model_folder_inner(&root, &variant))
}

/// Read a small text file (an imported pack's manifest.json) for the UI.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    const MAX_BYTES: u64 = 32 * 1024 * 1024;
    let meta = fs::metadata(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!("{path}: file too large ({} bytes)", meta.len()));
    }
    fs::read_to_string(&path).map_err(|e| format!("cannot read {path}: {e}"))
}

/// Full import: FBX + PSDs -> `<app_data>/packs/zairiza-synth-<variant>`.
/// Emits `import-progress` events per step; runs on a blocking thread.
#[tauri::command]
pub async fn run_import(
    app: AppHandle,
    variant: String,
    fbx_path: String,
    main_psd_path: String,
    clothing_psd_path: String,
) -> Result<(), String> {
    let resource_root = resource_root(&app)?;
    let pack_dir = packs_dir(&app)?.join(format!("zairiza-synth-{variant}"));
    let opts = ImportOptions {
        variant,
        fbx_path: PathBuf::from(fbx_path),
        main_psd_path: PathBuf::from(main_psd_path),
        clothing_psd_path: PathBuf::from(clothing_psd_path),
        resource_root,
        pack_dir,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let app_handle = app.clone();
        let progress = move |event: ProgressEvent| {
            let _ = app_handle.emit("import-progress", event);
        };
        run_import_inner(&opts, &progress)
    })
    .await
    .map_err(|e| format!("import task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("synthcreator3d-test-{tag}-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scan_packs_dir_reads_valid_and_skips_broken() {
        let tmp = TempDir::new("packs");
        let packs = tmp.path().join("packs");
        write(&packs.join("good/manifest.json"), r#"{"id":"good","name":"Good Pack"}"#);
        write(&packs.join("bad-json/manifest.json"), "not json");
        write(&packs.join("no-id/manifest.json"), r#"{"name":"x"}"#);
        fs::create_dir_all(packs.join("empty")).unwrap();
        let found = scan_packs_dir(&packs);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "good");
        assert_eq!(found[0].name, "Good Pack");
        assert!(found[0].path.ends_with("good"));
        assert!(scan_packs_dir(&tmp.path().join("missing")).is_empty());
    }

    #[test]
    fn pick_resource_root_requires_full_layout() {
        let tmp = TempDir::new("res");
        let good = tmp.path().join("resources");
        write(&good.join("pipeline/extract_textures.py"), "#");
        write(&good.join("python/python.exe"), "");
        write(&good.join("packs/zairiza-synth-sfw/manifest.json"), "{}");
        let bogus = tmp.path().join("other");
        fs::create_dir_all(&bogus).unwrap();
        assert_eq!(pick_resource_root(&[bogus.clone(), good.clone()]), Some(good));
        assert_eq!(pick_resource_root(&[bogus]), None);
    }

    #[test]
    fn merge_default_colors_only_touches_known_ids() {
        let mut manifest = json!({
            "colorRegions": [
                {"id": "main", "defaultColor": "#111111"},
                {"id": "visor", "defaultColor": "#222222"}
            ],
            "emissiveRegions": [
                {"id": "emission", "defaultColor": "#00ff00", "intensity": 1.0}
            ]
        });
        let colors = json!({"main": "#aabbcc", "unknown": "#000000"});
        let applied = merge_default_colors(&mut manifest, colors.as_object().unwrap());
        assert_eq!(applied, 1);
        assert_eq!(manifest["colorRegions"][0]["defaultColor"], "#aabbcc");
        assert_eq!(manifest["colorRegions"][1]["defaultColor"], "#222222");
        assert_eq!(manifest["emissiveRegions"][0]["defaultColor"], "#00ff00");
    }

    #[test]
    fn scan_finds_known_layouts() {
        let tmp = TempDir::new("scan");
        write(&tmp.path().join("SFW/FBX/Synth.fbx"), "fbx");
        write(&tmp.path().join("NSFW/FBX/Synth NSFW ALL.fbx"), "fbx");
        write(&tmp.path().join("SFW/Textures/PSDs/Synth Main Texture.psd"), "psd");
        write(&tmp.path().join("SFW/Textures/PSDs/Synth Clothing Texture.psd"), "psd");
        write(&tmp.path().join("NSFW/Textures/PSDs/Synth Main Texture NSFW.psd"), "psd");
        write(&tmp.path().join("NSFW/Textures/PSDs/Synth Clothing.psd"), "psd");

        let sfw = scan_model_folder_inner(tmp.path(), "sfw");
        assert!(sfw.fbx.unwrap().replace('\\', "/").ends_with("SFW/FBX/Synth.fbx"));
        assert!(sfw.main_psd.unwrap().contains("Synth Main Texture"));
        assert!(sfw.clothing_psd.unwrap().contains("Clothing"));

        let nsfw = scan_model_folder_inner(tmp.path(), "nsfw");
        assert!(nsfw.fbx.unwrap().replace('\\', "/").ends_with("NSFW/FBX/Synth NSFW ALL.fbx"));
        assert!(nsfw.main_psd.unwrap().contains("NSFW"));
        assert!(nsfw.clothing_psd.unwrap().contains("Clothing"));
    }

    #[test]
    fn scan_handles_picked_variant_subfolder() {
        let tmp = TempDir::new("scansub");
        // User picked the SFW subfolder directly: no variant word in paths.
        write(&tmp.path().join("FBX/Synth.fbx"), "fbx");
        write(&tmp.path().join("Textures/PSDs/Synth Main Texture.psd"), "psd");
        write(&tmp.path().join("Textures/PSDs/Synth Clothing Texture.psd"), "psd");
        let res = scan_model_folder_inner(tmp.path(), "sfw");
        assert!(res.fbx.unwrap().replace('\\', "/").ends_with("FBX/Synth.fbx"));
        assert!(res.main_psd.is_some());
        assert!(res.clothing_psd.is_some());
    }

    #[test]
    fn import_rejects_bad_variant_and_missing_inputs() {
        let tmp = TempDir::new("importerr");
        let res_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let opts = ImportOptions {
            variant: "bogus".to_string(),
            fbx_path: tmp.path().join("none.fbx"),
            main_psd_path: tmp.path().join("none.psd"),
            clothing_psd_path: tmp.path().join("none.psd"),
            resource_root: res_root.clone(),
            pack_dir: tmp.path().join("pack"),
        };
        let err = run_import_inner(&opts, &|_| {}).unwrap_err();
        assert!(err.contains("unknown variant"), "{err}");

        let opts = ImportOptions { variant: "sfw".to_string(), ..opts };
        let err = run_import_inner(&opts, &|_| {}).unwrap_err();
        assert!(err.contains("model FBX not found"), "{err}");
        assert!(!opts.pack_dir.exists());
    }

    /// Variant/file consistency guard: NSFW-named files under the SFW
    /// variant fail with a clear mismatch message before any pipeline step.
    #[test]
    fn import_rejects_nsfw_named_files_under_sfw_variant() {
        let tmp = TempDir::new("importmismatch");
        let res_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let fbx = tmp.path().join("Synth.fbx");
        let main = tmp.path().join("Synth Main Texture NSFW.psd");
        let clothing = tmp.path().join("Clothing Texture.psd");
        for p in [&fbx, &main, &clothing] {
            fs::write(p, b"dummy").unwrap();
        }
        let opts = ImportOptions {
            variant: "sfw".to_string(),
            fbx_path: fbx,
            main_psd_path: main,
            clothing_psd_path: clothing,
            resource_root: res_root,
            pack_dir: tmp.path().join("pack"),
        };
        let err = run_import_inner(&opts, &|_| {}).unwrap_err();
        assert!(err.contains("variant/file mismatch"), "{err}");
        assert!(err.contains("NSFW file"), "{err}");
        assert!(!opts.pack_dir.exists());
    }

    /// End-to-end error path with the REAL embedded Python: dummy files get
    /// through copy/manifest, then extract_textures must fail on the invalid
    /// PSD, the stderr tail surfaces, and the half-built pack is removed.
    #[test]
    fn import_fails_cleanly_on_invalid_psd() {
        let tmp = TempDir::new("importpsd");
        let res_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if !pick_resource_root(&[res_root.clone()]).is_some() {
            panic!("test requires the bundled resources at {}", res_root.display());
        }
        let fbx = tmp.path().join("Synth.fbx");
        let main_psd = tmp.path().join("main.psd");
        let clothing_psd = tmp.path().join("clothing.psd");
        fs::write(&fbx, "not really an fbx").unwrap();
        fs::write(&main_psd, "not really a psd").unwrap();
        fs::write(&clothing_psd, "not really a psd").unwrap();
        let pack_dir = tmp.path().join("pack");
        let events = std::sync::Mutex::new(Vec::new());
        let opts = ImportOptions {
            variant: "sfw".to_string(),
            fbx_path: fbx,
            main_psd_path: main_psd,
            clothing_psd_path: clothing_psd,
            resource_root: res_root,
            pack_dir: pack_dir.clone(),
        };
        let err = run_import_inner(&opts, &|e| events.lock().unwrap().push((e.step, e.status))).unwrap_err();
        assert!(err.contains("Extracting body/eye masks"), "{err}");
        assert!(err.contains("extract_textures"), "{err}");
        assert!(!pack_dir.exists(), "failed import must not leave a pack dir");
        let events = events.lock().unwrap();
        assert!(events.iter().any(|(s, st)| s == "model" && st == "done"));
        assert!(events.iter().any(|(s, st)| s == "masks-main" && st == "running"));
    }
}
