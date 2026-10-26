import SwiftUI
import WebKit
import UniformTypeIdentifiers

@MainActor
final class VisionWorkbench: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate,
                              WKScriptMessageHandlerWithReply, WKDownloadDelegate {
    @Published var isHome = true
    @Published var legacyActive = false
    @Published var loading = false
    @Published var ready = false
    @Published var error = ""
    @Published var projectName = UserDefaults.standard.string(forKey: "visionWorkbenchProjectName") ?? ""
    @Published var hasProject = false
    @Published var deviceName = "本机工程"
    @Published var syncStatus = "离线可用"
    @Published var exportedFile: URL?
    @Published var pendingScene: VisionSceneManifest?
    @Published var projectImmersed = false
    @Published var editorVisible = false
    @Published var sceneReady = false
    @Published var buildingScene = false
    @Published var openingScene = false
    @Published var sceneStatus = ""
    @Published var revision = ""
    @Published var sceneRevision = ""
    var sceneOperation: Task<Void, Never>?
    var replacingScene = false
    var projectSpaceVisible = false
    var generation = 0
    #if targetEnvironment(simulator)
    var appliedTestLaunch = false
    #endif
    var sceneIsOutdated: Bool { projectImmersed && !sceneRevision.isEmpty && revision != sceneRevision }
    @Published var webPrompt: String?
    var promptReply: ((Bool) -> Void)?
    private(set) var webView: WKWebView?
    private var server: VisionWorkbenchServer?
    private var pendingAction: [String: Any]?
    private var downloads: [ObjectIdentifier: URL] = [:]

    func openLocal(file: URL? = nil) {
        launch(remote: nil, name: "本机工程", file: file)
    }
    func connect(_ device: DiscoveredTeachingServer) {
        launch(remote: device.address, name: device.name)
    }
    private func launch(remote address: String?, name: String, file: URL? = nil) {
        guard !loading else { return }
        loading = true; error = ""; ready = false; editorVisible = false; sceneReady = false; hasProject = false
        buildingScene = false; openingScene = false; generation += 1
        Task {
            do {
                let remote = try address.map { try LANClient(address: $0).baseURL }
                if let remote {
                    var request = URLRequest(url: remote.appendingPathComponent("__atlas/work-sync/capabilities"))
                    request.timeoutInterval = 8
                    let (data, response) = try await LANClient.session.data(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200,
                          let capabilities = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          capabilities["local"] is Bool else { throw TeachingError("此电脑尚未提供完整工程同步，请更新并启动电脑服务") }
                }
                if server == nil {
                    guard let root = Bundle.main.url(forResource: "WebWorkbench", withExtension: nil) else { throw TeachingError("工作台资源未打包，请重新构建应用") }
                    let key = "visionWorkbenchSession"
                    let session = UserDefaults.standard.string(forKey: key) ?? UUID().uuidString
                    UserDefaults.standard.set(session, forKey: key)
                    let instance = VisionWorkbenchServer(root: root, sessionID: session)
                    try await instance.start(); server = instance
                    configureWebView(instance)
                }
                guard let server else { throw TeachingError("本机工作台未启动") }
                await server.selectRemote(remote)
                if let file {
                    pendingAction = ["type": "import", "id": try await server.registerImport(file), "name": file.lastPathComponent]
                } else { pendingAction = remote == nil ? nil : ["type": "sync"] }
                deviceName = name; syncStatus = remote == nil ? "本机自动保存" : "准备同步"
                isHome = false
                webView?.load(URLRequest(url: server.origin.appendingPathComponent("workbench")))
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
    private func configureWebView(_ server: VisionWorkbenchServer) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "atlasWorkbench")
        let settings: [String: Any] = ["native": true, "immersive": true, "token": server.token]
        let json = String(data: try! JSONSerialization.data(withJSONObject: settings), encoding: .utf8)!
        config.userContentController.addUserScript(WKUserScript(source: "window.AtlasVision = Object.freeze(\(json));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self; webView.uiDelegate = self
        webView.isOpaque = false; webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.accessibilityIdentifier = "vision-full-workbench"
        self.webView = webView
    }
    func command(_ type: String) {
        if type == "home" { sceneOperation?.cancel(); pendingScene = nil; generation += 1 }
        guard ready else {
            if type == "home" { webView?.stopLoading(); loading = false; isHome = true }
            return
        }
        let json = String(data: try! JSONSerialization.data(withJSONObject: ["type": type, "generation": generation]), encoding: .utf8)!
        webView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('atlas-vision-command', {detail: \(json)}))") { [weak self] _, error in
            if let error { self?.error = error.localizedDescription }
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "http",
              message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == Int(VisionWorkbenchServer.port),
              let value = message.body as? [String: Any], let type = value["type"] as? String else {
            replyHandler(nil, "工作台消息来源无效"); return
        }
        switch type {
        case "ready":
            ready = true; loading = false
            var action = pendingAction ?? ["type": "resume"]; action["generation"] = generation
            pendingAction = nil; replyHandler(action, nil)
        case "home":
            isHome = true; ready = false; editorVisible = false; buildingScene = false; openingScene = false
            sceneOperation?.cancel(); pendingScene = nil; replyHandler(true, nil)
        case "sceneProgress":
            if value["generation"] as? Int == generation {
                buildingScene = value["busy"] as? Bool ?? false; sceneStatus = value["message"] as? String ?? ""
            }
            replyHandler(true, nil)
        case "error": error = value["message"] as? String ?? "操作未完成"; replyHandler(true, nil)
        case "status":
            projectName = value["name"] as? String ?? ""; hasProject = value["hasProject"] as? Bool ?? false
            sceneReady = value["sceneReady"] as? Bool ?? false; revision = value["revision"] as? String ?? ""
            UserDefaults.standard.set(projectName, forKey: "visionWorkbenchProjectName")
            let phase = value["phase"] as? String ?? "idle"
            let failure = value["error"] as? String ?? ""
            syncStatus = !failure.isEmpty ? failure : ["pending": "等待电脑授权", "preparing": "正在准备工程", "receiving": "正在接收工程",
                                                      "connected": "双向同步 · 每 3 秒", "starting": "正在连接" ][phase] ?? "本机自动保存"
            replyHandler(true, nil)
        case "openScene":
            guard value["generation"] as? Int == generation, !isHome else { replyHandler(nil, "工程已切换"); return }
            let token = generation
            Task {
                do {
                    guard let object = value["manifest"] else { throw TeachingError("空间工程为空") }
                    let manifest = try JSONDecoder().decode(VisionSceneManifest.self, from: JSONSerialization.data(withJSONObject: object))
                    try await VisionSceneStore.shared.installManifest(manifest)
                    guard token == generation, !isHome else { throw CancellationError() }
                    sceneRevision = value["revision"] as? String ?? ""
                    pendingScene = manifest; replyHandler(true, nil)
                } catch { replyHandler(nil, error.localizedDescription) }
            }
        default: replyHandler(nil, "不支持的工作台操作")
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let local = url.scheme == "http" && url.host == "127.0.0.1" && url.port == Int(VisionWorkbenchServer.port)
        let blob = url.absoluteString.hasPrefix("blob:http://127.0.0.1:\(VisionWorkbenchServer.port)/")
        if navigationAction.shouldPerformDownload && (local || blob) { decisionHandler(.download); return }
        decisionHandler(local || blob || url.absoluteString == "about:blank" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.error = error.localizedDescription; loading = false
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.error = error.localizedDescription; loading = false
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false; loading = false; error = "工作台进程已退出。返回入口后可重新载入自动保存的工程。"
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        webPrompt = message; promptReply = { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        webPrompt = message; promptReply = completionHandler
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        do {
            let directory = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Exports", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let file = directory.appendingPathComponent(name.isEmpty ? "atlas-project.zip" : name)
            downloads[ObjectIdentifier(download)] = file; completionHandler(file)
        } catch { self.error = error.localizedDescription; completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        exportedFile = downloads.removeValue(forKey: ObjectIdentifier(download))
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file) }
        self.error = "导出未完成：\(error.localizedDescription)"
    }
}

struct WorkbenchWebView: UIViewRepresentable {
    let webView: WKWebView
    var interactive = true
    func makeUIView(context: Context) -> WorkbenchHostView {
        let view = WorkbenchHostView(); view.attach(webView, interactive: interactive); return view
    }
    func updateUIView(_ view: WorkbenchHostView, context: Context) { view.attach(webView, interactive: interactive) }
}

final class WorkbenchHostView: UIView {
    private weak var webView: WKWebView?
    private var interactive = true
    func attach(_ webView: WKWebView, interactive: Bool) {
        self.webView = webView; self.interactive = interactive
        if webView.superview !== self { addSubview(webView) }
        clipsToBounds = true
        isUserInteractionEnabled = interactive; accessibilityElementsHidden = !interactive
        webView.isUserInteractionEnabled = interactive; webView.accessibilityElementsHidden = !interactive
        accessibilityElements = interactive ? nil : []
        webView.isHidden = !interactive
        webView.alpha = interactive ? 1 : 0.001
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard let webView, webView.superview === self else { return }
        webView.frame = interactive ? bounds : CGRect(x: 0, y: 0, width: 1280, height: 900)
    }
}

// Keep the local document engine attached while its editing window is tucked
// away. WebKit continues synchronization; no desktop canvas is shown in space.
struct VisionWorkbenchEngine: View {
    @EnvironmentObject private var workbench: VisionWorkbench
    var body: some View {
        if workbench.projectImmersed && !workbench.editorVisible, let webView = workbench.webView {
            WorkbenchWebView(webView: webView, interactive: false).frame(width: 1, height: 1)
                .clipped().allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

// Both the gateway and the spatial tools can receive a fresh scene. Claim the
// request once, since both windows may coexist while the editor is open.
struct VisionProjectSceneCoordinator: ViewModifier {
    @EnvironmentObject private var workbench: VisionWorkbench
    @EnvironmentObject private var review: VisionSceneController
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    func body(content: Content) -> some View {
        content.onChange(of: workbench.pendingScene?.id) { _, _ in openPending() }
            .onChange(of: workbench.isHome) { _, home in
                if home && workbench.projectImmersed {
                    workbench.sceneOperation?.cancel(); review.stop()
                    Task { await dismissSpace(); openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "project-tools") }
                }
            }.task { openPending() }
    }
    private func openPending() {
        guard let scene = workbench.pendingScene, !workbench.openingScene, !workbench.isHome else { return }
        workbench.pendingScene = nil; workbench.openingScene = true
        let token = workbench.generation
        workbench.sceneOperation = Task {
            defer { if token == workbench.generation { workbench.openingScene = false; workbench.replacingScene = false } }
            do {
                if review.immersed {
                    workbench.replacingScene = true
                    if review.playing { review.togglePlayback() }
                    await dismissSpace()
                    // dismissImmersiveSpace may return before RealityView's
                    // disappearance callback. Finish the old scene lifecycle
                    // before attaching or preparing the shared scene graph.
                    for _ in 0..<100 {
                        if !workbench.projectSpaceVisible { break }
                        try await Task.sleep(for: .milliseconds(50))
                    }
                    guard !workbench.projectSpaceVisible else { throw TeachingError("空间仍在退出，请稍后重新进入") }
                }
                try Task.checkCancellation()
                try await review.prepare(scene, immersiveProject: true)
                try Task.checkCancellation()
                guard token == workbench.generation, !workbench.isHome else { throw CancellationError() }
                switch await openSpace(id: "project-space") {
                case .opened:
                    guard token == workbench.generation, !workbench.isHome, !Task.isCancelled else { review.stop(); await dismissSpace(); return }
                    review.immersed = true; workbench.projectImmersed = true; workbench.editorVisible = false
                    openWindow(id: "project-tools", value: "project-tools"); dismissWindow(id: "workspace")
                case .userCancelled:
                    review.stop(); restoreGateway(); workbench.sceneStatus = "空间已取消，可重新进入"
                default: review.stop(); restoreGateway(); workbench.error = "沉浸式空间未打开，请重试"
                }
            } catch is CancellationError {
                review.stop()
                if token == workbench.generation && !workbench.isHome { restoreGateway() }
            }
            catch { review.stop(); restoreGateway(); workbench.error = error.localizedDescription }
        }
    }
    private func restoreGateway() {
        workbench.projectImmersed = false; workbench.editorVisible = false
        openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "project-tools")
    }
}

struct VisionWorkbenchRoot: View {
    @EnvironmentObject private var workbench: VisionWorkbench
    @EnvironmentObject private var review: VisionSceneController
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var importPresented = false
    @State private var address = UserDefaults.standard.string(forKey: "visionWorkbenchAddress") ?? ""
    @State private var manual = false

    var body: some View {
        Group {
            if workbench.legacyActive {
                VStack(spacing: 0) {
                    HStack {
                        Button("返回工程入口", systemImage: "square.grid.2x2") { workbench.legacyActive = false }
                        Spacer(); Text("历史单模型示教").foregroundStyle(.secondary)
                    }.padding(20)
                    VisionWorkspaceView()
                }
            } else if workbench.isHome { home }
            else {
                VStack(spacing: 0) {
                    if workbench.editorVisible { toolbar }
                    ZStack {
                        if workbench.editorVisible || !workbench.projectImmersed, let webView = workbench.webView {
                            WorkbenchWebView(webView: webView, interactive: workbench.editorVisible).opacity(workbench.editorVisible ? 1 : 0.001)
                                .allowsHitTesting(workbench.editorVisible).accessibilityHidden(!workbench.editorVisible)
                        }
                        if !workbench.editorVisible { preparation }
                    }
                }
            }
        }.frame(minWidth: 1180, minHeight: 800)
        .fileImporter(isPresented: $importPresented, allowedContentTypes: [.zip, .json]) { result in
            switch result { case .success(let url): workbench.openLocal(file: url)
            case .failure(let error): workbench.error = error.localizedDescription }
        }
        .alert("工作台", isPresented: Binding(get: { workbench.webPrompt != nil }, set: { if !$0 { workbench.webPrompt = nil } })) {
            Button("取消", role: .cancel) { workbench.promptReply?(false); workbench.promptReply = nil }
            Button("确定") { workbench.promptReply?(true); workbench.promptReply = nil }
        } message: { Text(workbench.webPrompt ?? "") }
        .modifier(VisionProjectSceneCoordinator())
        .onChange(of: scenePhase) { _, phase in
            if phase == .background && !workbench.isHome { workbench.command("checkpoint") }
        }
        .onDisappear { if workbench.projectImmersed { workbench.editorVisible = false } }
    }
    private var preparation: some View {
        VStack(spacing: 24) {
            Image(systemName: "viewfinder").font(.system(size: 62, weight: .ultraLight)).foregroundStyle(.cyan)
            Text(workbench.projectName.isEmpty ? "打开沉浸式工程" : workbench.projectName).font(.largeTitle)
            if workbench.loading || workbench.buildingScene || workbench.openingScene {
                ProgressView(workbench.openingScene ? review.status : workbench.sceneStatus.isEmpty ? "正在载入工程…" : workbench.sceneStatus)
            } else {
                Text(workbench.hasProject ? "工程已准备好，以真实尺度进入空间" : "载入工程文件，或从电脑同步当前工程")
                    .foregroundStyle(.secondary)
            }
            Text(workbench.syncStatus).font(.callout).foregroundStyle(.secondary)
            if !workbench.error.isEmpty { Text(workbench.error).foregroundStyle(.orange).frame(maxWidth: 650) }
            HStack(spacing: 20) {
                if workbench.sceneReady && !workbench.buildingScene && !workbench.openingScene {
                    Button("进入空间", systemImage: "figure.walk") { workbench.command("scene") }
                        .accessibilityIdentifier("workbench-enter-space")
                }
                Button("编辑工具", systemImage: "slider.horizontal.3") { workbench.editorVisible = true }
                    .disabled(!workbench.ready || workbench.buildingScene || workbench.openingScene).accessibilityIdentifier("workbench-show-editor")
                Button("工程入口") { workbench.command("home") }.accessibilityIdentifier("workbench-home")
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity).padding(40).background(.regularMaterial).controlSize(.large)
    }
    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                HStack {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("ATLAS / VISION PRO").font(.callout.monospaced()).tracking(3).foregroundStyle(.cyan)
                        Text("工程工作台").font(.system(size: 44, weight: .medium))
                        Text("打开工程，进入地图与机器人所在的三维空间。")
                            .font(.title3).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "square.stack.3d.up").font(.system(size: 66, weight: .ultraLight)).foregroundStyle(.cyan)
                }
                HStack(alignment: .top, spacing: 24) {
                    VStack(alignment: .leading, spacing: 20) {
                        Label("选择设备同步", systemImage: "network").font(.title2)
                        Text("接收电脑当前工程，在两端继续编辑。首次连接需要电脑端允许同步。")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        ForEach(discovery.servers) { server in
                            Button { workbench.connect(server) } label: {
                                HStack(spacing: 16) {
                                    Image(systemName: "desktopcomputer").font(.title)
                                    VStack(alignment: .leading, spacing: 5) { Text(server.name); Text(server.address).font(.caption).foregroundStyle(.secondary) }
                                    Spacer(); Image(systemName: "arrow.right")
                                }.padding(12)
                            }.accessibilityIdentifier("workbench-device-\(server.id)")
                        }
                        if discovery.servers.isEmpty {
                            Label(discovery.isSearching ? "正在查找同一局域网的电脑…" : "尚未发现设备", systemImage: "wifi")
                                .foregroundStyle(.secondary).padding(.vertical, 16)
                        }
                        HStack {
                            Button("重新查找", systemImage: "arrow.clockwise") { discovery.start() }
                            Button("通过地址连接") { manual.toggle() }
                        }
                        if manual {
                            HStack {
                                TextField("电脑地址，如 192.168.0.2:21990", text: $address).textInputAutocapitalization(.never).autocorrectionDisabled()
                                    .accessibilityIdentifier("workbench-server-address")
                                Button("连接") {
                                    UserDefaults.standard.set(address, forKey: "visionWorkbenchAddress")
                                    workbench.connect(DiscoveredTeachingServer(id: "manual", name: "已选电脑", address: address))
                                }.accessibilityIdentifier("workbench-connect")
                            }
                        }
                        if discovery.servers.isEmpty && !discovery.message.isEmpty && !discovery.isSearching {
                            Text(discovery.message).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                    }.padding(28).frame(maxWidth: .infinity, minHeight: 340, alignment: .topLeading).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 24))
                    VStack(alignment: .leading, spacing: 20) {
                        Label("载入工程", systemImage: "folder").font(.title2)
                        Text("完整工程在头显本机运行。已载入的地图、机器人和任务可以离线编辑。")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button { workbench.openLocal() } label: {
                            VStack(alignment: .leading, spacing: 8) {
                                Label("载入当前工程", systemImage: "clock.arrow.circlepath")
                                Text(workbench.projectName.isEmpty ? "打开本机工作台与工程缓存" : workbench.projectName).font(.callout).foregroundStyle(.secondary)
                            }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.borderedProminent).tint(Color(red: 0.08, green: 0.48, blue: 0.54)).accessibilityIdentifier("workbench-open-local")
                        Button("载入工程文件", systemImage: "doc.zipper") { importPresented = true }
                            .accessibilityIdentifier("workbench-import")
                        Text("支持 Mac 导出的 ZIP 完整工程、双工作区工程及 JSON 配置。")
                            .font(.caption).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                    }.padding(28).frame(maxWidth: .infinity, minHeight: 340, alignment: .topLeading).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 24))
                }
                if workbench.loading { ProgressView("正在准备工程工作台…") }
                if !workbench.error.isEmpty { Text(workbench.error).foregroundStyle(.orange).accessibilityIdentifier("workbench-error") }
                HStack(spacing: 32) {
                    Label("地图与模型编辑", systemImage: "map")
                    Label("机器人与任务", systemImage: "point.3.connected.trianglepath.dotted")
                    Label("空间检查与回放", systemImage: "cube.transparent")
                }.font(.callout).foregroundStyle(.secondary)
                Button("打开历史单模型示教") { workbench.legacyActive = true }.font(.caption)
            }.padding(44).disabled(workbench.loading)
        }.task {
            discovery.start()
            #if targetEnvironment(simulator)
            if let test = UserDefaults.standard.string(forKey: "visionWorkbenchTestAddress") { address = test; manual = true }
            if !workbench.appliedTestLaunch, let file = UserDefaults.standard.string(forKey: "visionWorkbenchTestFile") {
                workbench.appliedTestLaunch = true; workbench.openLocal(file: URL(fileURLWithPath: file))
            }
            #endif
        }.onDisappear { discovery.stop() }
        .controlSize(.large)
    }
    private var toolbar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 18) {
                Button { workbench.command("home") } label: { Label("工程入口", systemImage: "square.grid.2x2") }
                    .accessibilityIdentifier("workbench-home")
                VStack(alignment: .leading, spacing: 4) {
                    Text(workbench.projectName.isEmpty ? "工程工作台" : workbench.projectName).font(.headline).lineLimit(1)
                    Text("\(workbench.deviceName) · \(workbench.syncStatus)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        .accessibilityIdentifier("workbench-sync-status")
                }
                Spacer(minLength: 12)
                if workbench.projectImmersed {
                    Button("收起工具", systemImage: "rectangle.compress.vertical") {
                        workbench.editorVisible = false; dismissWindow(id: "workspace")
                    }.accessibilityIdentifier("workbench-hide-editor")
                }
                Button("保存工程", systemImage: "square.and.arrow.down") { workbench.command("save") }
                    .disabled(!workbench.ready || !workbench.hasProject).accessibilityIdentifier("workbench-save")
                Button("空间场景", systemImage: "cube.transparent") { workbench.command("scene") }
                    .disabled(!workbench.ready || !workbench.hasProject || review.busy).accessibilityIdentifier("workbench-open-scene")
                if let exported = workbench.exportedFile { ShareLink("导出文件", item: exported).accessibilityIdentifier("workbench-exported") }
            }
            if !workbench.error.isEmpty {
                HStack { Text(workbench.error).font(.caption).foregroundStyle(.orange); Spacer(); Button("关闭") { workbench.error = "" } }
            }
        }.padding(.horizontal, 22).padding(.vertical, 12)
    }
}
