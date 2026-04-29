#![cfg_attr(windows, windows_subsystem = "windows")]
// Build as a windows-subsystem (GUI) binary on Windows so the OS doesn't
// allocate a console window when a GUI parent (the Tauri app) spawns us.
// Without this, every sidecar spawn pops up a cmd window — and worse, the
// fresh console can hijack stdin/stdout/stderr handles, breaking the IPC
// pipe that Tauri uses to read NDJSON from the crawler. The launcher itself
// has no UI; Tauri pipes our stdio to the sidecar via Stdio::inherit() below.

use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};

// Platform-specific name of the bundled Node.js binary. Linux .deb /
// AppImage builds ship `node`; Windows builds ship `node.exe`. macOS
// would also be `node` if we ever ship there.
#[cfg(windows)]
const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
const NODE_BIN: &str = "node";

fn main() {
    let exe = env::current_exe().expect("Failed to get exe path");
    let exe_dir = exe.parent().expect("Failed to get exe directory");

    // Production: node binary and script are siblings in Tauri install dir
    let node_prod = exe_dir.join("node").join(NODE_BIN);
    let script_prod = exe_dir.join("sidecar-bundle").join("index.js");

    // Dev: sidecar launcher is in src-tauri/binaries/, script is in sidecar/dist/
    let script_dev = exe_dir
        .join("..")
        .join("..")
        .join("sidecar")
        .join("dist")
        .join("index.js");

    let (node_exe, script, resources_dir) = if node_prod.exists() && script_prod.exists() {
        (node_prod, script_prod, exe_dir.to_path_buf())
    } else if script_dev.exists() {
        // Dev mode: use system node, resources are in src-tauri/
        let dev_resources = exe_dir.join("..");
        (PathBuf::from("node"), script_dev, dev_resources)
    } else {
        eprintln!("Error: Cannot find sidecar script");
        eprintln!("  Tried production: {:?}", script_prod);
        eprintln!("  Tried dev: {:?}", script_dev);
        std::process::exit(1);
    };

    let args: Vec<String> = env::args().skip(1).collect();

    let status = Command::new(&node_exe)
        .arg(&script)
        .args(&args)
        .env("FERA_RESOURCES_DIR", &resources_dir)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .unwrap_or_else(|e| {
            eprintln!("Failed to run {:?}: {}", node_exe, e);
            std::process::exit(1);
        });

    std::process::exit(status.code().unwrap_or(1));
}
