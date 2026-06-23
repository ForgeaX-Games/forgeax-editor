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
use tauri_plugin_shell::ShellExt;

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
        .run(tauri::generate_context!())
        .expect("error while running ForgeaX Studio desktop shell");
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

    let sidecar = app
        .shell()
        .sidecar("bun")?
        .args(["run", &main_ts.to_string_lossy()])
        .env("FORGEAX_RESOURCE_ROOT", res_root.to_string_lossy().to_string())
        .env("FORGEAX_PROJECT_ROOT", projects_dir.to_string_lossy().to_string())
        .env("FORGEAX_SERVE_SPA", "1")
        .env("FORGEAX_SERVER_HOST", "127.0.0.1")
        // Dedicated desktop ports (18810 / engine 15273) so the .app NEVER
        // collides with a running dev stack (server :18900 / engine :15173) —
        // otherwise the .app's server fails to bind 18900 and the webview talks
        // to whatever else holds the port. The SPA uses relative URLs, so the
        // port is transparent to the frontend.
        .env("FORGEAX_SERVER_PORT", server_port.to_string())
        // The server's /preview reverse-proxy targets this engine port.
        .env("FORGEAX_ENGINE_PORT", engine_port.to_string());

    // Keep the child handle alive for the app lifetime by leaking it; the OS
    // reaps it when the app exits. (A managed-state handle is the tidier option
    // if graceful shutdown is needed later.)
    let (_rx, child) = sidecar.spawn()?;
    std::mem::forget(child);

    // ── Engine preview sidecar (live vite dev server) ──
    // The game preview iframe loads /preview/?game=<slug>; the bundled server
    // reverse-proxies /preview/* → this engine vite on 127.0.0.1:15173. vite
    // needs a WRITABLE root (its cacheDir + a .forgeax/games symlink), but the
    // bundled engine lives under read-only Resources — so we materialize a
    // writable working dir: copy the small engine source files, symlink
    // node_modules back to the (real, bundled) Resources copy, and symlink
    // .forgeax → the user's project root. Best-effort: a preview that fails to
    // start never blocks the rest of the app (the iframe just 502s).
    let engine_res = res_root.join("engine");
    if engine_res.join("vite.config.ts").exists() {
        let engine_work = projects_dir.join(".engine-runtime");
        if let Err(e) = setup_engine_work(&engine_res, &engine_work, &projects_dir) {
            eprintln!("[forgeax] engine preview setup failed (preview disabled): {e}");
        } else {
            let vite_js = engine_work.join("node_modules/vite/bin/vite.js");
            match app
                .shell()
                .sidecar("bun")?
                .args(["run", &vite_js.to_string_lossy()])
                .current_dir(&engine_work)
                .env("FORGEAX_ENGINE_HOST", "127.0.0.1")
                .env("FORGEAX_ENGINE_PORT", engine_port.to_string())
                // HMR clientPort → the single .app origin (server proxies /preview ws).
                .env("FORGEAX_INTERFACE_PORT", server_port.to_string())
                .env("FORGEAX_PROJECT_ROOT", projects_dir.to_string_lossy().to_string())
                .spawn()
            {
                Ok((_rx2, eng_child)) => std::mem::forget(eng_child),
                Err(e) => eprintln!("[forgeax] engine vite sidecar spawn failed: {e}"),
            }
        }
    }

    // Poll the port off-thread so setup() doesn't block, then navigate + show.
    std::thread::spawn(move || {
        for _ in 0..600 {
            if std::net::TcpStream::connect(("127.0.0.1", server_port)).is_ok() {
                if let Some(win) = handle.get_webview_window("main") {
                    if let Ok(url) = format!("http://127.0.0.1:{server_port}").parse() {
                        let _ = win.navigate(url);
                    }
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Timed out: show the window anyway so the user isn't stuck on a blank
        // screen (the SPA's boot splash surfaces the backend fault).
        if let Some(win) = handle.get_webview_window("main") {
            let _ = win.show();
        }
    });

    Ok(())
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
