// ForgeaX Studio desktop shell (Tauri 2).
//
// Two runtime forms share this one shell (see docs in tauri.conf.json):
//   - dev  : `cargo tauri dev` loads the vite dev server (:18920); backend is
//            started by ../../start.sh. No sidecar.
//   - prod : `cargo tauri build` (Plan B) bundles the `bun` runtime + the
//            server source + node_modules + asset dists under Resources. On
//            launch we spawn `bun run <Resources>/resources/server/src/main.ts`,
//            which serves SPA + API on http://127.0.0.1:18900 (one origin), then
//            we navigate the (initially hidden) main window there and show it.
//
// The web UI is platform-agnostic: it detects Tauri via `__TAURI_INTERNALS__`
// (src/lib/platform/runtime.ts) and only then uses native window APIs; in a
// plain browser (web-server form) every native call is a no-op.

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
#[cfg(not(debug_assertions))]
use tauri::Emitter;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

// ───────────────────────── SidecarSupervisor ─────────────────────────
//
// The .app spawns two `bun` sidecars (server :18810, engine vite :15273).
// Historically both were `std::mem::forget`-leaked with their event Receiver
// dropped, which had three failure modes (see
// performance-analysis-2/07-desktop-tauri-supervision.md):
//   1. crash invisibility — a dead sidecar was never noticed nor restarted, so
//      the webview stayed on a now-dead origin and every API/WS/preview call
//      silently failed;
//   2. stdout back-pressure — the piped stdout/stderr channel had no consumer,
//      so once the OS pipe buffer filled, the sidecar's writes blocked;
//   3. orphan processes — no exit hook killed the sidecars, leaving bun holding
//      18810/15273 across relaunches.
//
// The Supervisor below owns each sidecar: it consumes the event stream (drains
// stdout/stderr to a rolling log file), restarts on Terminated with bounded
// exponential backoff, emits `backend-status` for the frontend, and is reaped
// on app exit via a RunEvent hook (SIGTERM → grace → SIGKILL by PID).
#[cfg(not(debug_assertions))]
mod supervisor {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use tauri_plugin_shell::process::{CommandChild, CommandEvent};

    /// Max restart attempts before a sidecar is declared `failed` (stops the
    /// crash-loop CPU burn). Counter resets after a sidecar stays up a while.
    const MAX_RESTARTS: u32 = 5;
    /// Grace period between SIGTERM and SIGKILL during shutdown.
    const KILL_GRACE: Duration = Duration::from_secs(3);

    /// How to (re)spawn a given sidecar. Returns the live child + its event rx.
    /// Boxed so the monitor task can respawn without re-borrowing the AppHandle's
    /// shell builder ownership at the call site.
    pub type SpawnFn = dyn Fn() -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String>
        + Send
        + Sync;

    /// A single supervised sidecar. The PID is mirrored into an atomic so the
    /// exit-reaper can signal it without locking the (possibly busy) child mutex.
    pub struct SidecarHandle {
        pub name: &'static str,
        pid: AtomicU32,
        /// Set once shutdown begins so the monitor loop stops restarting.
        shutting_down: Arc<AtomicBool>,
        spawn: Arc<SpawnFn>,
    }

    impl SidecarHandle {
        pub fn pid(&self) -> Option<u32> {
            match self.pid.load(Ordering::SeqCst) {
                0 => None,
                p => Some(p),
            }
        }
    }

    /// Owns both sidecars; lives in Tauri managed state.
    pub struct Supervisor {
        pub server: Arc<SidecarHandle>,
        pub engine: Arc<SidecarHandle>,
    }

    /// Append a chunk of sidecar output to a rolling per-sidecar log file under
    /// <projects>/.logs. Best-effort: logging must never crash the monitor.
    fn log_to_disk(log_dir: &std::path::Path, name: &str, bytes: &[u8]) {
        let _ = std::fs::create_dir_all(log_dir);
        let path = log_dir.join(format!("{name}.log"));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(bytes);
            let _ = f.write_all(b"\n");
        }
    }

    /// Roll the log if it grew past ~4 MiB so it can't grow unbounded.
    fn roll_log_if_big(log_dir: &std::path::Path, name: &str) {
        let path = log_dir.join(format!("{name}.log"));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 4 * 1024 * 1024 {
                let _ = std::fs::rename(&path, log_dir.join(format!("{name}.log.1")));
            }
        }
    }

    /// Spawn a supervised sidecar: consume its event stream on a background
    /// task, drain output to disk, and restart on Terminated with bounded
    /// exponential backoff. `spawn` is invoked once now and again on each
    /// restart. Returns the managed handle.
    pub fn spawn_supervised(
        app: &AppHandle,
        name: &'static str,
        log_dir: std::path::PathBuf,
        spawn: Arc<SpawnFn>,
    ) -> Result<Arc<SidecarHandle>, String> {
        let (rx, child) = spawn()?;
        let handle = Arc::new(SidecarHandle {
            name,
            pid: AtomicU32::new(child.pid()),
            shutting_down: Arc::new(AtomicBool::new(false)),
            spawn: spawn.clone(),
        });
        // The child lives in the monitor task (it consumes `rx`, which is tied to
        // this child). We don't store the CommandChild itself in the handle —
        // shutdown signals by PID instead, which works across restarts.
        let _ = app.emit(
            "backend-status",
            serde_json::json!({ "who": name, "state": "connecting" }),
        );
        spawn_monitor(app.clone(), handle.clone(), log_dir, rx, child);
        Ok(handle)
    }

    // `_child` is reassigned on each restart but never read — we hold it only so
    // the CommandChild isn't dropped (dropping closes its stdin pipe). The
    // reassignment-never-read warning is therefore expected.
    #[allow(unused_assignments)]
    fn spawn_monitor(
        app: AppHandle,
        handle: Arc<SidecarHandle>,
        log_dir: std::path::PathBuf,
        mut rx: tauri::async_runtime::Receiver<CommandEvent>,
        // child is held so it isn't dropped (dropping would close stdin); it is
        // replaced on each restart.
        mut _child: CommandChild,
    ) {
        tauri::async_runtime::spawn(async move {
            let name = handle.name;
            let mut restarts: u32 = 0;
            // Mark ready optimistically once the first chunk of output flows or
            // the loop has been alive briefly; HealthGate is the real readiness
            // signal, this is just for the frontend's connecting→ready hint.
            loop {
                let mut got_output_since_spawn = false;
                while let Some(ev) = rx.recv().await {
                    match ev {
                        CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                            if !got_output_since_spawn {
                                got_output_since_spawn = true;
                                // A live sidecar producing output resets the
                                // crash-loop counter so transient restarts later
                                // in the session aren't permanently penalized.
                                restarts = 0;
                                let _ = app.emit(
                                    "backend-status",
                                    serde_json::json!({ "who": name, "state": "ready" }),
                                );
                            }
                            roll_log_if_big(&log_dir, name);
                            log_to_disk(&log_dir, name, &b);
                        }
                        CommandEvent::Error(e) => {
                            log_to_disk(&log_dir, name, format!("[supervisor] error: {e}").as_bytes());
                        }
                        CommandEvent::Terminated(payload) => {
                            log_to_disk(
                                &log_dir,
                                name,
                                format!(
                                    "[supervisor] sidecar '{name}' terminated code={:?} signal={:?} (restart #{restarts})",
                                    payload.code, payload.signal
                                )
                                .as_bytes(),
                            );
                            break;
                        }
                        _ => {}
                    }
                }

                // rx closed == process gone. Decide whether to restart.
                handle.pid.store(0, Ordering::SeqCst);
                if handle.shutting_down.load(Ordering::SeqCst) {
                    return; // intentional shutdown, don't resurrect.
                }
                if restarts >= MAX_RESTARTS {
                    let _ = app.emit(
                        "backend-status",
                        serde_json::json!({ "who": name, "state": "failed" }),
                    );
                    log_to_disk(
                        &log_dir,
                        name,
                        format!("[supervisor] '{name}' exceeded MAX_RESTARTS={MAX_RESTARTS}, giving up")
                            .as_bytes(),
                    );
                    return;
                }

                let _ = app.emit(
                    "backend-status",
                    serde_json::json!({ "who": name, "state": "restarting", "attempt": restarts + 1 }),
                );
                // 0.5 → 1 → 2 → 4 → 8 → 16s cap.
                let backoff = Duration::from_millis(500u64 << restarts.min(5));
                restarts += 1;
                tokio::time::sleep(backoff).await;
                if handle.shutting_down.load(Ordering::SeqCst) {
                    return;
                }

                match (handle.spawn)() {
                    Ok((new_rx, new_child)) => {
                        handle.pid.store(new_child.pid(), Ordering::SeqCst);
                        rx = new_rx;
                        _child = new_child;
                        log_to_disk(
                            &log_dir,
                            name,
                            format!("[supervisor] '{name}' restarted (pid {})", handle.pid.load(Ordering::SeqCst))
                                .as_bytes(),
                        );
                        // loop back and consume the new rx.
                    }
                    Err(e) => {
                        log_to_disk(
                            &log_dir,
                            name,
                            format!("[supervisor] '{name}' respawn failed: {e}").as_bytes(),
                        );
                        // Treat a failed respawn like another crash for backoff
                        // purposes; loop continues with the same (now empty) rx
                        // by sleeping then retrying.
                        let backoff = Duration::from_millis(500u64 << restarts.min(5));
                        restarts += 1;
                        if restarts >= MAX_RESTARTS {
                            let _ = app.emit(
                                "backend-status",
                                serde_json::json!({ "who": name, "state": "failed" }),
                            );
                            return;
                        }
                        tokio::time::sleep(backoff).await;
                    }
                }
            }
        });
    }

    impl Supervisor {
        /// Kill both sidecars on app exit: SIGTERM, brief grace, then SIGKILL.
        /// Signals by PID (captured atomically) so it works regardless of which
        /// restart generation is live. Best-effort — the OS reaps anything left.
        pub fn shutdown_all(&self) {
            for h in [&self.server, &self.engine] {
                h.shutting_down.store(true, Ordering::SeqCst);
            }
            let pids: Vec<u32> = [&self.server, &self.engine]
                .iter()
                .filter_map(|h| h.pid())
                .collect();
            for pid in &pids {
                signal_pid(*pid, "TERM");
            }
            if !pids.is_empty() {
                std::thread::sleep(KILL_GRACE);
                for pid in &pids {
                    signal_pid(*pid, "KILL");
                }
            }
        }
    }

    /// Send a unix signal to a pid via /bin/kill (avoids a libc dependency).
    fn signal_pid(pid: u32, sig: &str) {
        let _ = std::process::Command::new("/bin/kill")
            .arg(format!("-{sig}"))
            .arg(pid.to_string())
            .status();
    }
}

/// Native mouse capture for FPS play. WKWebView denies the web Pointer Lock API
/// for embedded content, so we lock at the OS level instead: set_cursor_grab on
/// macOS calls CGAssociateMouseAndMouseCursorPosition(false), freezing the
/// cursor while mouse-move events keep flowing. The frontend toggles this on a
/// game click and off on ESC.
#[tauri::command]
fn set_pointer_capture(window: tauri::Window, capture: bool) {
    let _ = window.set_cursor_visible(!capture);
    let _ = window.set_cursor_grab(capture);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![set_pointer_capture])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                // Dev (desktop-dev mode): the web stack must already be running
                // via `bash start.sh` in another terminal — Tauri only loads the
                // vite devUrl (:18920). Guard against the #1 "blank window"
                // confusion by warning when that port isn't live yet.
                let dev_port: u16 = std::env::var("FORGEAX_INTERFACE_PORT")
                    .ok().and_then(|v| v.parse().ok()).unwrap_or(18920);
                if std::net::TcpStream::connect(("127.0.0.1", dev_port)).is_err() {
                    eprintln!(
                        "[forgeax] desktop-dev: nothing on :{dev_port} yet — run `bash start.sh` \
                         (server :18900 / UI :18920 / engine :15173) first, then the window will load."
                    );
                }
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    // DevTools is noisy (engine multi-light warnings etc.) and not
                    // wanted by default. Only auto-open when explicitly asked via
                    // FORGEAX_DEVTOOLS=1 (set by `bash app.sh debug`). You can always
                    // open it manually with the standard inspector shortcut.
                    if std::env::var("FORGEAX_DEVTOOLS").as_deref() == Ok("1") {
                        win.open_devtools();
                    }
                }
            }

            #[cfg(not(debug_assertions))]
            start_bundled_backend(app)?;

            build_tray(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ForgeaX Studio desktop shell")
        .run(|_app_handle, _event| {
            // Reap sidecars on app exit so bun doesn't orphan and hold
            // 18810/15273 across relaunches. Only the bundled (.app) form spawns
            // sidecars; dev relies on the external `start.sh` stack.
            #[cfg(not(debug_assertions))]
            {
                use tauri::{Manager, RunEvent};
                if matches!(
                    _event,
                    RunEvent::ExitRequested { .. } | RunEvent::Exit
                ) {
                    if let Some(sup) = _app_handle.try_state::<supervisor::Supervisor>() {
                        sup.shutdown_all();
                    }
                }
            }
        });
}

/// Plan B: spawn the bundled `bun` sidecar to run the server, wait for the
/// port, then point the main window at the local origin and reveal it.
#[cfg(not(debug_assertions))]
fn start_bundled_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Box<dyn Error> so `?` unifies tauri::Error (resource_dir) and
    // tauri_plugin_shell::Error (sidecar/spawn) — the latter has no
    // From-conversion into tauri::Error. The setup() closure returns the same
    // boxed-error type, so the call site needs no change.
    use std::fs;

    let handle = app.handle().clone();

    // Resources layout (assembled by scripts/build-desktop.sh):
    //   <resource_dir>/resources/{server,interface/dist,marketplace,builtin,brand}
    let res_root = app.path().resource_dir()?.join("resources");
    let main_ts = res_root.join("server").join("src").join("main.ts");

    // User workspace (writable) — distinct from the read-only bundled assets.
    let projects_dir = app
        .path()
        .home_dir()
        .map(|h| h.join("ForgeaxProjects"))
        .unwrap_or_else(|_| res_root.clone());
    let _ = fs::create_dir_all(&projects_dir);

    // Seed the game template so "new game" scaffolding works — resolveGameTemplate
    // (server) looks for <projectRoot>/.forgeax/games/_template. Copy the bundled
    // template once, if absent (build-desktop.sh ships resources/game-template).
    let template_src = res_root.join("game-template");
    let template_dst = projects_dir.join(".forgeax").join("games").join("_template");
    if template_src.exists() && !template_dst.exists() {
        if let Some(parent) = template_dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = std::process::Command::new("cp")
            .arg("-R").arg(&template_src).arg(&template_dst).status();
    }

    // Shared game library (official examples) → symlinked into the project, the
    // .app analogue of dev's run.sh §3.5. build-desktop.sh ships a read-only
    // COPY at <Resources>/resources/games; we link each forge.json-bearing game
    // into the project's .forgeax/games/<slug> so the engine + server discovery
    // chain sees them like locally-created games.
    seed_shared_games(&res_root, &projects_dir);

    // Desktop ports — env-overridable, defaulting to the dedicated 18810/15273
    // (kept distinct from dev's 18900/15173 so the .app and a dev stack coexist).
    let server_port: u16 = std::env::var("FORGEAX_DESKTOP_SERVER_PORT")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(18810);
    let engine_port: u16 = std::env::var("FORGEAX_DESKTOP_ENGINE_PORT")
        .ok().and_then(|v| v.parse().ok()).unwrap_or(15273);

    // Per-sidecar rolling logs (perf-analysis §6 observability): a crashed
    // sidecar's stdout/stderr lands here for post-mortem instead of vanishing.
    let log_dir = projects_dir.join(".logs");

    // ── Server sidecar (SPA + API + /preview reverse-proxy) ──
    // Build a SpawnFn closure that fully re-creates the command each time, so the
    // supervisor can restart it after a crash. The bundled `bun` sidecar runs
    // server/src/main.ts on the dedicated desktop server port.
    let server_spawn: std::sync::Arc<supervisor::SpawnFn> = {
        let app = app.handle().clone();
        let main_ts = main_ts.clone();
        let res_root = res_root.clone();
        let projects_dir = projects_dir.clone();
        std::sync::Arc::new(move || {
            app.shell()
                .sidecar("bun")
                .map_err(|e| e.to_string())?
                .args(["run", &main_ts.to_string_lossy()])
                .env("FORGEAX_RESOURCE_ROOT", res_root.to_string_lossy().to_string())
                .env("FORGEAX_PROJECT_ROOT", projects_dir.to_string_lossy().to_string())
                .env("FORGEAX_SERVE_SPA", "1")
                .env("FORGEAX_SERVER_HOST", "127.0.0.1")
                // Dedicated desktop ports (18810 / engine 15273) so the .app
                // NEVER collides with a running dev stack (server :18900 /
                // engine :15173) — otherwise the .app's server fails to bind and
                // the webview talks to whatever else holds the port. The SPA
                // uses relative URLs, so the port is transparent to the frontend.
                .env("FORGEAX_SERVER_PORT", server_port.to_string())
                // The server's /preview reverse-proxy targets this engine port.
                .env("FORGEAX_ENGINE_PORT", engine_port.to_string())
                .spawn()
                .map_err(|e| e.to_string())
        })
    };
    let server_handle =
        supervisor::spawn_supervised(&handle, "server", log_dir.clone(), server_spawn)
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;

    // ── Engine preview sidecar (live vite dev server) ──
    // The game preview iframe loads /preview/?game=<slug>; the bundled server
    // reverse-proxies /preview/* → this engine vite. vite needs a WRITABLE root
    // (its cacheDir + a .forgeax/games symlink), but the bundled engine lives
    // under read-only Resources — so we materialize a writable working dir: copy
    // the small engine source files, symlink node_modules back to the (real,
    // bundled) Resources copy, and symlink .forgeax → the user's project root.
    // Best-effort: a preview that fails to set up never blocks the rest of the
    // app (the iframe just 502s); when it does set up, it is supervised too.
    let engine_res = res_root.join("engine");
    let engine_handle: Option<std::sync::Arc<supervisor::SidecarHandle>> =
        if engine_res.join("vite.config.ts").exists() {
            let engine_work = projects_dir.join(".engine-runtime");
            if let Err(e) = setup_engine_work(&engine_res, &engine_work, &projects_dir) {
                eprintln!("[forgeax] engine preview setup failed (preview disabled): {e}");
                None
            } else {
                let vite_js = engine_work.join("node_modules/vite/bin/vite.js");
                let engine_spawn: std::sync::Arc<supervisor::SpawnFn> = {
                    let app = app.handle().clone();
                    let engine_work = engine_work.clone();
                    let projects_dir = projects_dir.clone();
                    std::sync::Arc::new(move || {
                        app.shell()
                            .sidecar("bun")
                            .map_err(|e| e.to_string())?
                            .args(["run", &vite_js.to_string_lossy()])
                            .current_dir(&engine_work)
                            .env("FORGEAX_ENGINE_HOST", "127.0.0.1")
                            .env("FORGEAX_ENGINE_PORT", engine_port.to_string())
                            // HMR clientPort → the single .app origin (server
                            // proxies /preview ws).
                            .env("FORGEAX_INTERFACE_PORT", server_port.to_string())
                            .env(
                                "FORGEAX_PROJECT_ROOT",
                                projects_dir.to_string_lossy().to_string(),
                            )
                            .spawn()
                            .map_err(|e| e.to_string())
                    })
                };
                match supervisor::spawn_supervised(
                    &handle,
                    "engine",
                    log_dir.clone(),
                    engine_spawn,
                ) {
                    Ok(h) => Some(h),
                    Err(e) => {
                        eprintln!("[forgeax] engine vite sidecar spawn failed: {e}");
                        None
                    }
                }
            }
        } else {
            None
        };

    // The engine handle is optional (preview may be disabled); when absent we
    // give the Supervisor a placeholder no-op handle so shutdown logic is
    // uniform and the HealthGate skips the engine probe.
    let have_engine = engine_handle.is_some();
    let engine_for_state = engine_handle.unwrap_or_else(|| server_handle.clone());
    app.manage(supervisor::Supervisor {
        server: server_handle,
        engine: engine_for_state,
    });

    // ── HealthGate ──
    // Only navigate + show once BOTH the server (/api/health → 200) and the
    // engine (/preview reachable) are ready. Previously this only TCP-probed the
    // server and, on timeout, blindly showed a window that 502s on Edit/Play. On
    // timeout we now navigate to the origin anyway but emit a `failed`
    // backend-status so the SPA can surface an explicit error rather than a
    // blank/502 view.
    std::thread::spawn(move || {
        const ATTEMPTS: u32 = 600; // 600 × 100ms = 60s
        let mut server_ready = false;
        let mut engine_ready = !have_engine; // skip if preview disabled
        for _ in 0..ATTEMPTS {
            if !server_ready {
                server_ready = http_ok("127.0.0.1", server_port, "/api/health");
            }
            if !engine_ready {
                // vite's dev server answers /preview (proxied through server) and
                // also responds directly on its own port; probe the engine port
                // directly so we don't depend on the server proxy being up first.
                engine_ready = http_reachable("127.0.0.1", engine_port, "/");
            }
            if server_ready && engine_ready {
                if let Some(win) = handle.get_webview_window("main") {
                    if let Ok(url) = format!("http://127.0.0.1:{server_port}").parse() {
                        let _ = win.navigate(url);
                    }
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                let _ = handle.emit(
                    "backend-status",
                    serde_json::json!({ "who": "gate", "state": "ready" }),
                );
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Timed out: surface an explicit fault instead of pretending everything
        // is fine. We still navigate + show so the SPA's boot splash can render
        // the error, and we emit which side stalled.
        let _ = handle.emit(
            "backend-status",
            serde_json::json!({
                "who": "gate",
                "state": "failed",
                "serverReady": server_ready,
                "engineReady": engine_ready,
            }),
        );
        if let Some(win) = handle.get_webview_window("main") {
            if let Ok(url) = format!("http://127.0.0.1:{server_port}").parse() {
                let _ = win.navigate(url);
            }
            let _ = win.show();
            let _ = win.set_focus();
        }
    });

    Ok(())
}

/// Minimal HTTP/1.0 GET probe (avoids pulling in reqwest). Returns true only on
/// a `200` status line. Used by the HealthGate for the server's /api/health.
#[cfg(not(debug_assertions))]
fn http_ok(host: &str, port: u16, path: &str) -> bool {
    http_status_line(host, port, path)
        .map(|line| line.contains(" 200"))
        .unwrap_or(false)
}

/// True if the host:port answered HTTP at all (any status line). Used for the
/// engine vite probe — vite serving anything (even a 404) means it's up.
#[cfg(not(debug_assertions))]
fn http_reachable(host: &str, port: u16, path: &str) -> bool {
    http_status_line(host, port, path).is_some()
}

/// Send a GET and return the first response line, or None on connect/IO error
/// or timeout. Short timeouts keep the 100ms poll cadence honest.
#[cfg(not(debug_assertions))]
fn http_status_line(host: &str, port: u16, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect(&addr).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf).ok()?;
    if n == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buf[..n]);
    text.lines().next().map(|s| s.to_string())
}

/// Materialize a WRITABLE engine working dir from the read-only bundled copy:
/// real source files + a node_modules symlink back to Resources + a .forgeax
/// symlink to the user's project root. vite then runs here with a writable
/// cacheDir (./.vite) and resolves /preview/.forgeax/games/<slug>/… correctly.
#[cfg(not(debug_assertions))]
fn setup_engine_work(
    engine_res: &std::path::Path,
    engine_work: &std::path::Path,
    projects_dir: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::fs;
    use std::os::unix::fs::symlink;

    fs::create_dir_all(engine_work)?;

    // vite.config.ts must be a REAL file here so its `here` (= its own dir)
    // resolves to engine_work — keeping cacheDir + .forgeax/games rooted here.
    for f in ["index.html", "vite.config.ts", "package.json", "pack-catalog.ts", "tsconfig.json"] {
        let src = engine_res.join(f);
        if src.exists() {
            fs::copy(&src, engine_work.join(f))?;
        }
    }
    // src/ + public/ (recursive, refreshed each launch so upgrades land).
    for dir in ["src", "public"] {
        let src = engine_res.join(dir);
        if src.exists() {
            let dst = engine_work.join(dir);
            let _ = fs::remove_dir_all(&dst);
            let ok = std::process::Command::new("cp")
                .arg("-R").arg(&src).arg(&dst).status()?.success();
            if !ok {
                return Err(format!("cp -R {dir} failed").into());
            }
        }
    }
    // node_modules → the real, bundled Resources copy (read-only; vite only
    // reads it, all writes go to engine_work/.vite). Recreate the link each run.
    let nm = engine_work.join("node_modules");
    let _ = fs::remove_file(&nm);
    symlink(engine_res.join("node_modules"), &nm)?;

    // .forgeax → project root, so /preview/.forgeax/games/<slug>/… resolves to
    // the games the server writes under FORGEAX_PROJECT_ROOT. Pre-create the
    // games dir so the link is live (and vite's rescan watcher attaches) even
    // before the first game exists.
    let _ = fs::create_dir_all(projects_dir.join(".forgeax").join("games"));
    let fx = engine_work.join(".forgeax");
    let _ = fs::remove_file(&fx);
    let _ = symlink(projects_dir.join(".forgeax"), &fx);

    Ok(())
}

/// Seed the shared game library (official examples) into the user's project,
/// mirroring dev's run.sh §3.5. PARITY: this is the .app-side twin of
/// `scripts/seed-games.ts` (which dev/run.sh invokes) — kept in Rust here so the
/// bundled app has no Bun-script dependency at launch. Keep the algorithm in
/// sync with that script. The .app ships a read-only COPY under
/// <Resources>/resources/games (one game dir each, all carrying forge.json);
/// here we symlink each into <projectRoot>/.forgeax/games/<slug> so the engine
/// + server discovery chain (listAllGames / detectActiveSlug) treats them
/// identically to locally-created games. `slug` is forge.json#id (authoritative,
/// matching run.sh), falling back to the directory name. A REAL directory at
/// the same slug as a bundled shared-library game is treated as a stale copy
/// (someone copied instead of linking — silently lies through edits); we move
/// it aside as `<slug>.bak-<unix-ts>` and install the symlink. A real dir
/// whose slug does NOT collide with any bundled game (a user's own work) is
/// preserved untouched.
#[cfg(not(debug_assertions))]
fn seed_shared_games(res_root: &std::path::Path, projects_dir: &std::path::Path) {
    use std::fs;
    use std::os::unix::fs::symlink;

    let games_src = res_root.join("games");
    let Ok(entries) = fs::read_dir(&games_src) else { return };
    let games_dst = projects_dir.join(".forgeax").join("games");
    let _ = fs::create_dir_all(&games_dst);

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let forge = dir.join("forge.json");
        if !forge.exists() {
            continue; // forge.json is the symlink guard (README + scripts are skipped)
        }
        // slug = forge.json#id, fall back to the directory name.
        let slug = fs::read_to_string(&forge)
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
            .and_then(|v| v.get("id").and_then(|i| i.as_str()).map(str::to_owned))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());

        let target = games_dst.join(&slug);
        match fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() => {
                // Refresh: re-point at the current bundled copy (path changes
                // across app versions / .app moves).
                let _ = fs::remove_file(&target);
                let _ = symlink(&dir, &target);
            }
            Ok(_) => {
                // Real dir at a shared-library slug — stale copy. Move aside
                // and install the symlink. Mirrors scripts/seed-games.ts.
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let backup = games_dst.join(format!("{slug}.bak-{stamp}"));
                if fs::rename(&target, &backup).is_ok() {
                    let _ = symlink(&dir, &target);
                }
            }
            Err(_) => {
                let _ = symlink(&dir, &target);
            }
        }
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 Show", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏 Hide", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("ForgeaX Studio")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
