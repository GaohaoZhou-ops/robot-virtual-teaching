import Foundation
import Combine
import Network

struct DiscoveredTeachingServer: Identifiable {
    let id: String
    let name: String
    let address: String
}

@MainActor
final class LANServiceDiscovery: ObservableObject {
    static let serviceType = "_atlas-teach._tcp"
    @Published private(set) var servers: [DiscoveredTeachingServer] = []
    @Published private(set) var isSearching = false
    @Published private(set) var message = "可搜索同一局域网内的电脑"
    private var browser: NWBrowser?
    private var deadline: Task<Void, Never>?
    private var directedProbe: Task<Void, Never>?
    private var connections: [NWEndpoint: NWConnection] = [:]
    private var tasks: [NWEndpoint: Task<Void, Never>] = [:]
    private var attempted: Set<NWEndpoint> = []
    private var verified: [NWEndpoint: DiscoveredTeachingServer] = [:]
    private var generation = UUID()

    private func parameters() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.prohibitedInterfaceTypes = [.cellular]
        parameters.includePeerToPeer = false
        // The teaching protocol currently accepts LAN IPv4 and .local hosts.
        (parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options)?.version = .v4
        return parameters
    }
    // iPad probes exactly the address in its input fields. Bonjour browsing
    // remains available through start() for the Vision Pro workflow.
    func probe(address: String) {
        resetProbe()
        let input = LANAddressInput(address: address)
        let client = input.canConnect ? try? LANClient(address: input.address) : nil
        let generation = self.generation
        let feedbackDeadline = ContinuousClock.now.advanced(by: .milliseconds(1500))
        isSearching = true
        message = client == nil ? "正在检查电脑地址和端口…" : "正在检测 \(input.displayAddress)…"
        // An overall deadline also covers a server that keeps sending a partial
        // response, which can continually reset a request's inactivity timeout.
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            guard let self, self.generation == generation else { return }
            self.stop()
            self.message = "检测超时，请检查地址、端口和电脑服务。"
        }
        directedProbe = Task { [weak self] in
            var server: DiscoveredTeachingServer?
            let resultMessage: String
            if let client {
                do {
                    let info = try await client.identify()
                    server = DiscoveredTeachingServer(id: info.serverId, name: info.serverName,
                                                      address: client.baseURL.absoluteString)
                    resultMessage = "已找到电脑，点击下方卡片输入配对码。"
                } catch {
                    resultMessage = "未连接到该地址的 Atlas 服务，请检查地址、端口和电脑服务。"
                }
            } else {
                resultMessage = "请先填写有效的电脑地址和端口。"
            }
            // Keep both the globe and the searching message stable for at least
            // 1.5 seconds, including fast failures. Slow requests add no delay.
            do {
                try await ContinuousClock().sleep(until: feedbackDeadline)
                try Task.checkCancellation()
            } catch { return }
            guard let self, self.generation == generation else { return }
            self.stop()
            self.servers = server.map { [$0] } ?? []
            self.message = resultMessage
        }
    }
    func resetProbe() {
        stop(); servers = []
        message = "仅检测上方填写的电脑地址和端口。"
    }
    func start() {
        guard !isSearching else { return }
        stop(); servers = []; verified = [:]; attempted = []
        isSearching = true; message = "正在搜索局域网示教服务…"
        let generation = self.generation
        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: "local."), using: parameters())
        self.browser = browser
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self, self.generation == generation else { return }
                switch state {
                case .failed(let error), .waiting(let error):
                    if case .dns(-65570) = error { // kDNSServiceErr_PolicyDenied
                        self.stop(); self.message = "请在系统设置中允许 Atlas 示教访问本地网络，再重新搜索。"
                    } else if case .failed = state {
                        self.stop(); self.message = "搜索暂不可用，请检查 Wi-Fi，也可手动填写电脑地址。"
                    }
                default: break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, self.generation == generation else { return }
                self.update(results, generation: generation)
            }
        }
        browser.start(queue: .main)
        deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(12)) } catch { return }
            guard let self, self.generation == generation else { return }
            self.stop()
            self.message = self.servers.isEmpty
                ? ""
                : "找到 \(self.servers.count) 个服务，点选后输入电脑上的配对码。"
        }
    }
    func stop() {
        generation = UUID()
        browser?.cancel(); browser = nil
        deadline?.cancel(); deadline = nil
        directedProbe?.cancel(); directedProbe = nil
        connections.values.forEach { $0.cancel() }; connections.removeAll()
        tasks.values.forEach { $0.cancel() }; tasks.removeAll()
        isSearching = false
    }
    private func update(_ results: Set<NWBrowser.Result>, generation: UUID) {
        let endpoints = Set(results.map(\.endpoint))
        for endpoint in attempted.subtracting(endpoints) {
            connections.removeValue(forKey: endpoint)?.cancel()
            tasks.removeValue(forKey: endpoint)?.cancel()
            verified.removeValue(forKey: endpoint); attempted.remove(endpoint)
        }
        refreshServers()
        for result in results where !attempted.contains(result.endpoint) && attempted.count < 16 {
            resolve(result.endpoint, generation: generation)
        }
    }
    private func resolve(_ endpoint: NWEndpoint, generation: UUID) {
        attempted.insert(endpoint)
        let connection = NWConnection(to: endpoint, using: parameters())
        connections[endpoint] = connection
        tasks[endpoint] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(4)) } catch { return }
            guard let self, self.generation == generation else { return }
            self.connections.removeValue(forKey: endpoint)?.cancel()
            self.tasks.removeValue(forKey: endpoint)
        }
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            Task { @MainActor in
                guard let self, let connection, self.generation == generation,
                      self.connections[endpoint] === connection else { return }
                switch state {
                case .ready:
                    let remote = connection.currentPath?.remoteEndpoint
                    self.connections.removeValue(forKey: endpoint)?.cancel()
                    self.tasks.removeValue(forKey: endpoint)?.cancel()
                    guard case .hostPort(let host, let port) = remote,
                          case .ipv4(let ip) = host else { return }
                    // Bonjour endpoints carry an interface scope (such as %en0);
                    // HTTP IPv4 URLs use the four address octets without that scope.
                    let ipv4Host = ip.rawValue.map { String($0) }.joined(separator: ".")
                    let address = "http://\(ipv4Host):\(port.rawValue)"
                    self.tasks[endpoint] = Task { [weak self] in
                        do {
                            let info = try await LANClient(address: address).identify()
                            try Task.checkCancellation()
                            guard let self, self.generation == generation, self.attempted.contains(endpoint) else { return }
                            self.verified[endpoint] = DiscoveredTeachingServer(id: info.serverId, name: info.serverName, address: address)
                            self.refreshServers()
                            self.message = "找到 \(self.servers.count) 个服务，点选后输入电脑上的配对码。"
                        } catch { /* Ignore unrelated, unreachable or incompatible services. */ }
                        if let self, self.generation == generation { self.tasks.removeValue(forKey: endpoint) }
                    }
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: endpoint)?.cancel()
                    self.tasks.removeValue(forKey: endpoint)?.cancel()
                default: break
                }
            }
        }
        connection.start(queue: .main)
    }
    private func refreshServers() {
        var unique: [String: DiscoveredTeachingServer] = [:]
        for server in verified.values { unique[server.id] = server }
        servers = unique.values.sorted { $0.name == $1.name ? $0.address < $1.address : $0.name < $1.name }
    }
    deinit {
        browser?.cancel(); deadline?.cancel(); directedProbe?.cancel()
        connections.values.forEach { $0.cancel() }
        tasks.values.forEach { $0.cancel() }
    }
}
