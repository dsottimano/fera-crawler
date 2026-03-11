use std::env;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn main() {
    let exe = env::current_exe().expect("Failed to get exe path");
    let exe_dir = exe.parent().expect("Failed to get exe directory");

    // Production: node.exe and script are siblings in Tauri install dir
    let node_prod = exe_dir.join("node").join("node.exe");
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
