import SwiftUI
import WebKit

struct IPadLibraryItem: Codable {
    let id: String
    let name: String
    let mode: String
    let savedAt: Double
    let taskCount: Int
    let poseCount: Int
}

struct IPadLibraryProject: Codable, Identifiable {
    let serverURL: String
    let item: IPadLibraryItem
    var id: String { serverURL + "|" + item.id }
}

struct IPadWorkbenchLaunch: Identifiable {
    let id = UUID()
    var project: IPadLibraryProject?
}

/// The payload stays in WebKit's persistent local database. This small native
/// catalog makes each independent snapshot available before opening WebKit.
@MainActor
final class IPadWorkbenchLibrary: ObservableObject {
    static let shared = IPadWorkbenchLibrary()
    @Published private(set) var projects: [IPadLibraryProject] = []
    @Published private(set) var error = ""
    private var indexURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("AtlasWorkbenchProjects", isDirectory: true).appendingPathComponent("index.json")
    }
    private init() {
        guard UIDevice.current.userInterfaceIdiom == .pad, let url = indexURL,
              FileManager.default.fileExists(atPath: url.path) else { return }
        do { projects = try JSONDecoder().decode([IPadLibraryProject].self, from: Data(contentsOf: url)) }
        catch { self.error = "离线工程列表读取失败，打开离线协作后可重新读取本机工程。" }
    }
    func update(serverURL: URL, items: Any) throws {
        let data = try JSONSerialization.data(withJSONObject: items)
        let items = try JSONDecoder().decode([IPadLibraryItem].self, from: data)
        guard items.count <= 5000, Set(items.map(\.id)).count == items.count,
              items.allSatisfy({ !$0.id.isEmpty && $0.id.count <= 512 && !$0.name.isEmpty && $0.name.count <= 1024
                  && ["map", "independent"].contains($0.mode) && $0.savedAt.isFinite && $0.savedAt > 0
                  && $0.taskCount >= 0 && $0.poseCount >= 0 }), let url = indexURL else {
            throw TeachingError("离线工程列表格式无效")
        }
        let source = serverURL.absoluteString
        let updated = (projects.filter { $0.serverURL != source }
            + items.map { IPadLibraryProject(serverURL: source, item: $0) }).sorted { $0.item.savedAt > $1.item.savedAt }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(updated).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        projects = updated; error = ""
    }
}

private final class IPadLibraryMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var owner: IPadWorkbench?
    init(owner: IPadWorkbench) { self.owner = owner }
    @MainActor
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let owner else { replyHandler(nil, "工作台已关闭"); return }
        owner.handleLibraryMessage(message, reply: replyHandler)
    }
}

struct IPadWorkbenchPrompt: Identifiable {
    enum Kind { case alert, confirm, text }
    let id = UUID()
    let kind: Kind
    let message: String
    var defaultText = ""
}

/// The ordinary website runs in its own persistent WebKit store. No Vision Pro
/// bridge is installed: imports, local editing and work sync use the browser paths.
@MainActor
final class IPadWorkbench: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    @Published var address = LANAddressInput(address: UserDefaults.standard.string(forKey: "ipadWorkbenchAddress")
                                           ?? UserDefaults.standard.string(forKey: "serverAddress") ?? "")
    @Published private(set) var webView: WKWebView?
    @Published private(set) var connecting = false
    @Published private(set) var loading = false
    @Published private(set) var progress = 0.0
    @Published private(set) var serverName = ""
    @Published var error = ""
    @Published var prompt: IPadWorkbenchPrompt?
    @Published var exportedFile: TeachingResultShareItem?
    @Published private(set) var returningToLibrary = false
    @Published private(set) var didReturnToLibrary = false
    @Published private(set) var pageUnavailable = false
    private(set) var requestedProject: IPadLibraryProject?
    private var origin: URL?
    private var connectionTask: Task<Void, Never>?
    private var connectionID = UUID()
    private var progressObservation: NSKeyValueObservation?
    private var promptReply: ((String?) -> Void)?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var exportQueue: [URL] = []
    private var closeRequest: (id: String, finish: (Bool) -> Void)?
    private var closeTimeout: Task<Void, Never>?
    private var canRunPageScript = false

    init(project: IPadLibraryProject? = nil) {
        requestedProject = project
        super.init()
        if let project { address = LANAddressInput(address: project.serverURL) }
    }

    fileprivate func handleLibraryMessage(_ message: WKScriptMessage, reply: (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              let origin, let url = message.frameInfo.request.url, allows(url), url.scheme != "about",
              let body = message.body as? [String: Any], let type = body["type"] as? String else {
            reply(nil, "工程列表消息来源无效"); return
        }
        do {
            switch type {
            case "return":
                reply([:], nil)
                returnToApp()
            case "launch": reply(requestedProject.map { ["id": $0.item.id] } ?? [:], nil)
            case "opened":
                if body["id"] as? String == requestedProject?.item.id { requestedProject = nil }
                reply([:], nil)
            case "projects":
                try IPadWorkbenchLibrary.shared.update(serverURL: origin, items: body["projects"] ?? [])
                reply([:], nil)
            case "flushed", "flushFailed":
                if let request = closeRequest, body["id"] as? String == request.id {
                    if type == "flushFailed" { error = "返回前保存未完成，请重试：\(body["message"] as? String ?? "本机存储不可用")" }
                    closeRequest = nil; closeTimeout?.cancel(); closeTimeout = nil
                    request.finish(type == "flushed")
                }
                reply([:], nil)
            case "error": error = String((body["message"] as? String ?? "离线工程保存失败").prefix(1000)); reply([:], nil)
            default: reply(nil, "未知的工程列表消息")
            }
        } catch { self.error = "更新本机工程列表失败：\(error.localizedDescription)"; reply(nil, self.error) }
    }

    func returnToApp() {
        Task { if await saveAndClose() { didReturnToLibrary = true } }
    }

    private func saveAndClose() async -> Bool {
        guard !returningToLibrary else { return false }
        returningToLibrary = true
        defer { returningToLibrary = false }
        guard let webView, canRunPageScript else { close(); return true }
        let id = UUID().uuidString
        // The Objective-C evaluation entry point supports older iPadOS without
        // requiring the new SDK's Swift WebKit overlay at application launch.
        let saved = await withCheckedContinuation { continuation in
            closeRequest = (id, { continuation.resume(returning: $0) })
            webView.evaluateJavaScript("""
            void (async () => {
              try {
                if (window.AtlasIPadLibrary) await window.AtlasIPadLibrary.flush();
                await window.webkit.messageHandlers.atlasIPadProjects.postMessage({type:'flushed',id:'\(id)'});
              } catch (error) {
                await window.webkit.messageHandlers.atlasIPadProjects.postMessage({type:'flushFailed',id:'\(id)',message:String(error.message || error)});
              }
            })();
            """) { [weak self] _, error in
                if let error { self?.failClose(id: id, message: error.localizedDescription) }
            }
            closeTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                self?.failClose(id: id, message: "保存等待超时，工程页面仍保留。")
            }
        }
        if saved { close() }
        return saved
    }

    private func failClose(id: String, message: String) {
        guard let request = closeRequest, request.id == id else { return }
        closeRequest = nil; closeTimeout?.cancel(); closeTimeout = nil
        error = "返回前保存未完成，请重试：\(message)"; request.finish(false)
    }

    // Scope touch behavior to this app's WebKit pages. Keep native selection and
    // copy/paste inside editors without intercepting taps, drags or pinch gestures.
    private static let touchInteractionScript = """
    (() => {
      const style = document.createElement('style');
      style.textContent = `
        * {
          -webkit-user-select: none !important;
          user-select: none !important;
          -webkit-touch-callout: none !important;
        }
        input, textarea,
        [contenteditable]:not([contenteditable="false"]),
        [contenteditable]:not([contenteditable="false"]) * {
          -webkit-user-select: text !important;
          user-select: text !important;
          -webkit-touch-callout: default !important;
        }
      `;
      (document.head || document.documentElement).appendChild(style);
    })();
    """

    func connect(server: DiscoveredTeachingServer? = nil) {
        guard UIDevice.current.userInterfaceIdiom == .pad, !connecting else { return }
        if let server { address = LANAddressInput(address: server.address) }
        guard address.canConnect else { error = "请填写电脑的 IPv4 地址和端口。"; return }
        connectionTask?.cancel()
        let id = UUID(); connectionID = id
        connecting = true; error = ""
        let input = address.address
        connectionTask = Task { [weak self] in
            do {
                let client = try LANClient(address: input)
                let info = try await client.identify()
                try Task.checkCancellation()
                guard let self, self.connectionID == id else { return }
                if let project = self.requestedProject, project.serverURL != client.baseURL.absoluteString {
                    throw TeachingError("请使用保存此工程时的电脑地址：\(project.serverURL)。工程数据仍保留在此 iPad。")
                }
                self.origin = client.baseURL
                self.serverName = info.serverName
                UserDefaults.standard.set(client.baseURL.absoluteString, forKey: "ipadWorkbenchAddress")
                self.configureWebView()
                self.connecting = false
                self.webView?.load(URLRequest(url: self.requestedProject == nil ? client.baseURL : client.baseURL.appendingPathComponent("workbench")))
            } catch {
                guard let self, self.connectionID == id, !Task.isCancelled else { return }
                self.connecting = false
                self.error = "无法打开电脑工作台：\(error.localizedDescription)"
            }
        }
    }

    private func configureWebView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.preferredContentMode = .desktop
        configuration.applicationNameForUserAgent = "AtlasIPadWorkbench/1"
        configuration.userContentController.addScriptMessageHandler(IPadLibraryMessageHandler(owner: self), contentWorld: .page, name: "atlasIPadProjects")
        configuration.userContentController.addUserScript(WKUserScript(source: Self.touchInteractionScript,
            injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self; web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        web.accessibilityIdentifier = "ipad-full-workbench"
        #if DEBUG
        web.isInspectable = true
        #endif
        progressObservation = web.observe(\.estimatedProgress, options: [.new]) { [weak self] web, _ in
            let value = web.estimatedProgress
            Task { @MainActor in self?.progress = value }
        }
        webView = web
    }

    func reload() {
        error = ""; pageUnavailable = false
        if let webView, webView.url != nil { webView.reload() }
        else if let origin { webView?.load(URLRequest(url: origin)) }
    }

    func close() {
        if let request = closeRequest { failClose(id: request.id, message: "工作台已关闭") }
        connectionID = UUID(); connectionTask?.cancel(); connectionTask = nil; connecting = false
        answerPrompt(nil)
        // Navigate away so the website can run its normal pagehide persistence
        // and disconnect handlers, just as when leaving its browser tab.
        webView?.load(URLRequest(url: URL(string: "about:blank")!))
    }

    private func allows(_ url: URL) -> Bool {
        if url.absoluteString == "about:blank" { return true }
        let target = url.scheme == "blob" ? URL(string: String(url.absoluteString.dropFirst(5))) : url
        guard let target, let origin else { return false }
        func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
        return target.scheme == origin.scheme && target.host == origin.host && port(target) == port(origin)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        guard allows(url) else {
            if action.navigationType == .linkActivated, ["http", "https"].contains(url.scheme) {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel); return
        }
        decisionHandler(action.shouldPerformDownload ? .download : .allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, allows(url) { webView.load(navigationAction.request) }
        return nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode >= 400 {
            error = "电脑工作台暂时不可用（\(http.statusCode)），请检查电脑服务后重试。"
            loading = false; pageUnavailable = true; decisionHandler(.cancel); return
        }
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        loading = true; error = ""; pageUnavailable = false
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { canRunPageScript = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false }
    private func navigationFailed(_ failure: Error) {
        if (failure as NSError).code == NSURLErrorCancelled { return }
        loading = false; pageUnavailable = true
        error = "工作台加载失败，请检查与电脑的局域网连接后重试。\(failure.localizedDescription)"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        navigationFailed(error)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationFailed(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loading = false; pageUnavailable = true; canRunPageScript = false
        error = "工作台进程已退出。点击重试可恢复已自动保存的工程。"
    }

    func answerPrompt(_ value: String?) {
        let reply = promptReply; promptReply = nil; prompt = nil; reply?(value)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        promptReply = { _ in completionHandler() }; prompt = IPadWorkbenchPrompt(kind: .alert, message: message)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        promptReply = { completionHandler($0 != nil) }; prompt = IPadWorkbenchPrompt(kind: .confirm, message: message)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt message: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        promptReply = completionHandler
        prompt = IPadWorkbenchPrompt(kind: .text, message: message, defaultText: defaultText ?? "")
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        do {
            let directory = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("Workbench Exports", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = URL(fileURLWithPath: suggestedFilename).lastPathComponent
            let file = directory.appendingPathComponent(name.isEmpty || [".", ".."].contains(name) ? "atlas-project.zip" : name)
            downloads[ObjectIdentifier(download)] = file; completionHandler(file)
        } catch { self.error = "无法保存导出文件：\(error.localizedDescription)"; completionHandler(nil) }
    }
    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(allows) == true ? .allow : .cancel)
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        exportQueue.append(file); presentNextExport()
    }
    func presentNextExport() {
        if exportedFile == nil, !exportQueue.isEmpty { exportedFile = TeachingResultShareItem(url: exportQueue.removeFirst()) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: file) }
        self.error = "导出未完成：\(error.localizedDescription)"
    }
}

private struct IPadWorkbenchWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ view: WKWebView, context: Context) {}
}

struct IPadWorkbenchView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var workbench: IPadWorkbench
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var promptText = ""
    private let accent = Color(red: 0.35, green: 0.86, blue: 0.91)
    init(project: IPadLibraryProject? = nil) {
        _workbench = StateObject(wrappedValue: IPadWorkbench(project: project))
    }
    var body: some View {
        VStack(spacing: 0) {
            if workbench.loading { ProgressView(value: workbench.progress).progressViewStyle(.linear).tint(accent) }
            if !workbench.error.isEmpty {
                HStack(alignment: .top) {
                    Label(workbench.error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange)
                        .accessibilityIdentifier("ipad-workbench-error")
                    Spacer(minLength: 12)
                    if workbench.pageUnavailable {
                        Button("重试", action: workbench.reload)
                        Button("回到协作", action: workbench.returnToApp).disabled(workbench.returningToLibrary)
                    } else {
                        Button("关闭提示") { workbench.error = "" }.font(.caption)
                    }
                }.padding(12).background(Color.orange.opacity(0.08))
            }
            if let web = workbench.webView {
                IPadWorkbenchWebView(webView: web).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(!workbench.returningToLibrary)
            }
            else { connectionForm }
        }
        .overlay {
            if workbench.returningToLibrary {
                ProgressView("正在保存工程…").padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        .tint(accent).preferredColorScheme(.dark)
        .task { if workbench.requestedProject != nil { connect() } }
        .onDisappear { discovery.stop(); workbench.close() }
        .onChange(of: workbench.didReturnToLibrary) { _, returned in if returned { dismiss() } }
        .onChange(of: workbench.prompt?.id) { _, _ in promptText = workbench.prompt?.defaultText ?? "" }
        .alert("工作台提示", isPresented: Binding(get: { workbench.prompt != nil }, set: { if !$0 { workbench.answerPrompt(nil) } }),
               presenting: workbench.prompt) { prompt in
            if prompt.kind == .text { TextField("输入内容", text: $promptText) }
            if prompt.kind != .alert { Button("取消", role: .cancel) { workbench.answerPrompt(nil) } }
            Button("确定") { workbench.answerPrompt(prompt.kind == .text ? promptText : "ok") }
        } message: { prompt in Text(prompt.message) }
        .sheet(item: $workbench.exportedFile, onDismiss: { workbench.presentNextExport() }) { file in
            TeachingResultShareSheet(url: file.url) { _, _, error in
                if let error { workbench.error = "分享未完成：\(error.localizedDescription)" }
            }
        }
    }

    private var connectionForm: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    Label("在 iPad 使用完整工作台", systemImage: "rectangle.on.rectangle").font(.title2.weight(.medium))
                    Text("iPad 与电脑连接同一局域网，电脑保持示教服务运行。打开后可编辑、导入和导出工程，也可通过“同步作业 → 离线协作”同步电脑当前工程。")
                        .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 16) {
                    LANAddressFields(address: $workbench.address) { connect() }
                        .disabled(workbench.connecting)
                    Button(action: { connect() }) {
                        HStack { if workbench.connecting { ProgressView().controlSize(.small) }
                            Text(workbench.connecting ? "正在连接电脑…" : "打开完整工作台").frame(maxWidth: .infinity)
                        }.frame(minHeight: 32)
                    }.buttonStyle(.borderedProminent).disabled(workbench.connecting || !workbench.address.canConnect)
                        .accessibilityIdentifier("open-ipad-workbench")
                    Button("取消", action: workbench.returnToApp).frame(maxWidth: .infinity)
                        .accessibilityIdentifier("ipad-workbench-cancel")
                }.padding(20).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Label("局域网电脑", systemImage: "desktopcomputer").font(.headline)
                        Spacer()
                        Button { discovery.start() } label: {
                            if discovery.isSearching { ProgressView().controlSize(.small) } else { Text("搜索电脑") }
                        }.buttonStyle(.bordered).disabled(discovery.isSearching || workbench.connecting)
                            .accessibilityIdentifier("discover-workbench-servers")
                    }
                    Text(discovery.message).font(.caption).foregroundStyle(.secondary)
                    ForEach(discovery.servers) { server in
                        Button { connect(server) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(server.name).foregroundStyle(.primary)
                                    Text(server.address).font(.caption.monospaced()).foregroundStyle(.secondary)
                                }
                                Spacer(); Image(systemName: "arrow.right")
                            }.padding(16).background(accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain).disabled(workbench.connecting)
                    }
                }
            }.padding(24).frame(maxWidth: 720).frame(maxWidth: .infinity)
        }.scrollDismissesKeyboard(.interactively).accessibilityIdentifier("ipad-workbench-connection")
    }
    private func connect(_ server: DiscoveredTeachingServer? = nil) {
        discovery.stop()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        workbench.connect(server: server)
    }
}
