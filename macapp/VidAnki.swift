// VidAnki menu bar app: starts the VidAnki server, opens (or focuses) its
// Chrome tab, and lives in the menu bar until you quit it.
import AppKit
import ServiceManagement

let port = 8770
let siteURL = URL(string: "http://localhost:\(port)")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem!
    private var server: Process?          // nil when someone else runs the server
    private var stopping = false
    private var restarts = 0
    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "Open at Login", action: #selector(toggleLogin), keyEquivalent: "")

    private var projectDir: URL {
        let path = Bundle.main.object(forInfoDictionaryKey: "VidAnkiProjectDir") as? String ?? "~/vidanki"
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }
    private var logURL: URL { projectDir.appendingPathComponent("data/server.log") }

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        setIcon(ok: true)
        let menu = NSMenu()
        menu.delegate = self
        menu.addItem(withTitle: "Open VidAnki", action: #selector(openSite), keyEquivalent: "o")
        menu.addItem(withTitle: "Open Anki", action: #selector(openAnki), keyEquivalent: "a")
        menu.addItem(.separator())
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(withTitle: "Restart Server", action: #selector(restartServer), keyEquivalent: "r")
        menu.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "l")
        menu.addItem(.separator())
        menu.addItem(loginItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit VidAnki", action: #selector(quit), keyEquivalent: "q")
        statusItem.menu = menu

        ensureServer { ok in if ok { self.openSite() } }
    }

    // Launching the app again (Dock, Spotlight, Finder) just brings the tab back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        ensureServer { ok in if ok { self.openSite() } }
        return false
    }

    func applicationWillTerminate(_ note: Notification) { stopServer() }

    func menuWillOpen(_ menu: NSMenu) {
        if let s = server, s.isRunning {
            statusLine.title = "Server running · port \(port)"
        } else if server == nil {
            statusLine.title = isUp() ? "Server running (started elsewhere)" : "Server stopped"
        } else {
            statusLine.title = "Server stopped"
        }
        loginItem.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    // MARK: server

    private func isUp() -> Bool {
        var req = URLRequest(url: siteURL.appendingPathComponent("api/state"))
        req.timeoutInterval = 1.5
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            ok = (resp as? HTTPURLResponse)?.statusCode == 200
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return ok
    }

    private func pythonPath() -> String {
        let candidates = [
            "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/python3"
    }

    private func ensureServer(then done: @escaping (Bool) -> Void) {
        DispatchQueue.global().async {
            if self.isUp() { DispatchQueue.main.async { self.setIcon(ok: true); done(true) }; return }
            DispatchQueue.main.sync { self.startServer() }
            for _ in 0..<40 {  // wait up to ~10 s
                if self.isUp() { DispatchQueue.main.async { self.setIcon(ok: true); done(true) }; return }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async {
                self.setIcon(ok: false)
                self.alert("VidAnki server didn't start", "See the server log for the error.")
                done(false)
            }
        }
    }

    private func startServer() {
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
        log?.write("\n--- started \(Date()) ---\n".data(using: .utf8)!)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: pythonPath())
        p.arguments = ["-u", "server.py", "--port", "\(port)"]
        p.currentDirectoryURL = projectDir
        var env = ProcessInfo.processInfo.environment
        // apps launched from Finder get a bare PATH; the server needs ffprobe (Homebrew)
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        p.environment = env
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async { self?.serverExited(proc) }
        }
        do {
            try p.run()
            server = p
            stopping = false
        } catch {
            alert("Couldn't start the VidAnki server", error.localizedDescription)
        }
    }

    private func serverExited(_ proc: Process) {
        guard proc === server, !stopping else { return }
        setIcon(ok: false)
        // restart after a crash, but don't loop forever
        if restarts < 3 {
            restarts += 1
            ensureServer { _ in }
        }
    }

    private func stopServer() {
        guard let p = server, p.isRunning else { return }
        stopping = true
        p.terminate()
        p.waitUntilExit()
    }

    @objc private func restartServer() {
        stopServer()
        server = nil
        restarts = 0
        ensureServer { _ in }
    }

    // MARK: actions

    @objc func openSite() {
        // Focus an existing VidAnki tab in Chrome instead of opening another one.
        let script = """
        tell application "Google Chrome"
            activate
            set found to false
            repeat with w in windows
                set i to 0
                repeat with t in tabs of w
                    set i to i + 1
                    if URL of t starts with "\(siteURL.absoluteString)" then
                        set active tab index of w to i
                        set index of w to 1
                        set found to true
                        exit repeat
                    end if
                end repeat
                if found then exit repeat
            end repeat
            if not found then
                if (count of windows) = 0 then
                    make new window
                    set URL of active tab of front window to "\(siteURL.absoluteString)"
                else
                    tell front window to make new tab with properties {URL:"\(siteURL.absoluteString)"}
                end if
            end if
        end tell
        """
        var err: NSDictionary?
        NSAppleScript(source: script)?.executeAndReturnError(&err)
        if err != nil {  // no Chrome, or automation permission denied: open it plainly
            let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome")
            if let chrome = chrome {
                NSWorkspace.shared.open([siteURL], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration())
            } else {
                NSWorkspace.shared.open(siteURL)
            }
        }
    }

    @objc private func openAnki() {
        if let anki = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "net.ankiweb.dtop") {
            NSWorkspace.shared.openApplication(at: anki, configuration: NSWorkspace.OpenConfiguration())
        }
    }

    @objc private func showLog() { NSWorkspace.shared.open(logURL) }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            alert("Couldn't change Open at Login", error.localizedDescription)
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: helpers

    private func setIcon(ok: Bool) {
        let name = ok ? "play.rectangle" : "exclamationmark.triangle"
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "VidAnki")
        img?.isTemplate = true
        statusItem.button?.image = img
        statusItem.button?.toolTip = ok ? "VidAnki" : "VidAnki: server stopped"
    }

    private func alert(_ title: String, _ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.runModal()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // menu bar only, no Dock icon
app.run()
