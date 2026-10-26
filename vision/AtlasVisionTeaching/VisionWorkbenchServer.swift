import Foundation
import Network

// A loopback-only origin gives WebKit the same modules, Web Workers, WebGL and
// persistent IndexedDB as the desktop engine, including when Wi-Fi is absent.
// LAN traffic is restricted to the explicitly selected Atlas service. Uploads
// and downloads stream through temporary files instead of base64 JS messages.
final class VisionWorkbenchServer: @unchecked Sendable {
    static let port: UInt16 = 21991
    let origin = URL(string: "http://127.0.0.1:21991")!
    let token = UUID().uuidString + UUID().uuidString
    private let queue = DispatchQueue(label: "atlas.vision.workbench.http")
    private let root: URL
    private let sceneStore: VisionSceneStore
    private var listener: NWListener?
    private var remote: URL?
    private var imports: [String: URL] = [:]
    private var connections: [UUID: HTTPConnection] = [:]
    private let sessionID: String
    private let startedAt = ISO8601DateFormatter().string(from: Date())

    init(root: URL, sessionID: String, sceneStore: VisionSceneStore = .shared) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath(); self.sessionID = sessionID; self.sceneStore = sceneStore
    }

    func start() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    let parameters = NWParameters.tcp
                    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
                    let listener = try NWListener(using: parameters)
                    self.listener = listener
                    var completed = false
                    listener.stateUpdateHandler = { state in
                        guard !completed else { return }
                        switch state {
                        case .ready: completed = true; continuation.resume()
                        case .failed(let error): completed = true; continuation.resume(throwing: error)
                        default: break
                        }
                    }
                    listener.newConnectionHandler = { connection in
                        guard self.connections.count < 48 else { connection.cancel(); return }
                        let id = UUID()
                        let client = HTTPConnection(connection, queue: self.queue, handler: self.respond,
                                                    finished: { self.connections.removeValue(forKey: id) })
                        self.connections[id] = client; client.start()
                    }
                    listener.start(queue: self.queue)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }
    func selectRemote(_ url: URL?) async {
        await withCheckedContinuation { continuation in queue.async { self.remote = url; continuation.resume() } }
    }
    func registerImport(_ source: URL) async throws -> String {
        let id = UUID().uuidString
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("VisionWorkbenchImports", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(id)
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let bytes = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard bytes > 0, bytes <= 1024 * 1024 * 1024 else { throw TeachingError("工程文件为空或超过 1 GB") }
        try FileManager.default.copyItem(at: source, to: target)
        await withCheckedContinuation { continuation in queue.async { self.imports[id] = target; continuation.resume() } }
        return id
    }

    private func respond(_ request: HTTPRequest, _ reply: @escaping (HTTPResponse) -> Void) {
        guard request.headers["host"] == "127.0.0.1:\(Self.port)",
              request.headers["origin"].map({ $0 == origin.absoluteString }) ?? true,
              request.headers["sec-fetch-site"] != "cross-site",
              request.target.hasPrefix("/"), !request.target.hasPrefix("//"),
              let components = URLComponents(string: request.target) else {
            reply(.json(403, ["error": "请求来源无效"])); return
        }
        let path = components.path
        if path.hasPrefix("/__atlas/vision-native/") {
            guard request.headers["authorization"] == "Bearer \(token)" else {
                reply(.json(401, ["error": "本机工程凭据无效"])); return
            }
            if path.hasPrefix("/__atlas/vision-native/imports/"),
               let id = path.split(separator: "/").last.map(String.init), let file = imports[id] {
                if request.method == "GET" { reply(.file(file, type: "application/zip")); return }
                if request.method == "DELETE" {
                    try? FileManager.default.removeItem(at: file); imports.removeValue(forKey: id)
                    reply(.json(200, ["ok": true])); return
                }
            }
            if path.hasPrefix("/__atlas/vision-native/assets/"), request.method == "PUT",
               let hash = path.split(separator: "/").last.map(String.init), let file = request.body {
                Task {
                    do { try await sceneStore.installAsset(file, hash: hash); reply(.json(200, ["ok": true])) }
                    catch { reply(.json(400, ["error": error.localizedDescription])) }
                }
                return
            }
            reply(.json(404, ["error": "本机资源不存在"])); return
        }
        if path == "/__atlas/session" {
            reply(.json(200, ["sessionId": sessionID, "startedAt": startedAt])); return
        }
        if path.hasPrefix("/__atlas/") {
            if let remote { proxy(request, to: remote, reply: reply); return }
            switch path {
            case "/__atlas/work-sync/capabilities": reply(.json(200, ["local": false, "offline": true]))
            case "/__atlas/robots": reply(.json(200, ["robots": []]))
            case "/__atlas/physics/config": reply(.json(200, ["backend": "local", "available": false]))
            case "/__atlas/ipad/info": reply(.json(200, ["protocol": "atlas-ipad-teaching/1", "serverId": sessionID,
                                                         "serverName": "Vision Pro", "addresses": []]))
            case "/__atlas/ipad-screen/info": reply(.json(200, ["usbSupported": false, "wirelessSupported": false,
                                                                "usbBridgeSupported": false, "addresses": []]))
            case "/__atlas/ipad-screen/devices": reply(.json(200, ["supported": false, "devices": []]))
            default: reply(.json(503, ["error": "此功能需要连接电脑；本机工程可继续编辑和保存"]));
            }
            return
        }
        guard request.method == "GET" || request.method == "HEAD" else { reply(.json(405, ["error": "请求方法无效"])); return }
        let relative = ["/", "/workbench", "/teaching-data", "/model-editor", "/model-editor/dual"].contains(path)
            ? "index.html" : String(path.dropFirst())
        let file = root.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(root.path + "/"), !relative.contains("\0"),
              FileManager.default.fileExists(atPath: file.path) else { reply(.json(404, ["error": "应用资源不存在"])); return }
        let types = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css",
                     "json": "application/json", "wasm": "application/wasm", "svg": "image/svg+xml", "png": "image/png"]
        reply(.file(file, type: types[file.pathExtension] ?? "application/octet-stream", head: request.method == "HEAD"))
    }
    private func proxy(_ source: HTTPRequest, to remote: URL, reply: @escaping (HTTPResponse) -> Void) {
        guard let url = URL(string: source.target, relativeTo: remote)?.absoluteURL,
              url.host == remote.host, url.port == remote.port else { reply(.json(403, ["error": "电脑地址无效"])); return }
        var request = URLRequest(url: url); request.httpMethod = source.method; request.timeoutInterval = 240
        for name in ["authorization", "content-type", "accept"] {
            if let value = source.headers[name] { request.setValue(value, forHTTPHeaderField: name) }
        }
        // A simulator shares the Mac's loopback IP, but must never become the
        // authorizing host. This header can only reduce server privileges.
        request.setValue("vision-pro", forHTTPHeaderField: "X-Atlas-Client")
        Task {
            do {
                if let body = source.body {
                    let (data, response) = try await LANClient.session.upload(for: request, fromFile: body)
                    guard let http = response as? HTTPURLResponse else { throw TeachingError("电脑响应无效") }
                    reply(HTTPResponse(status: http.statusCode, type: http.mimeType ?? "application/json", data: data))
                } else {
                    let (file, response) = try await LANClient.session.download(for: request)
                    guard let http = response as? HTTPURLResponse else { throw TeachingError("电脑响应无效") }
                    reply(.file(file, type: http.mimeType ?? "application/octet-stream", status: http.statusCode, delete: true))
                }
            } catch { reply(.json(502, ["error": "电脑连接中断，已载入的工程保留在本机。\(error.localizedDescription)"])) }
        }
    }
}

private struct HTTPRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: URL?
}
private struct HTTPResponse {
    var status: Int = 200
    var type: String
    var data: Data? = nil
    var file: URL? = nil
    var delete = false
    var head = false
    static func json(_ status: Int, _ object: [String: Any]) -> Self {
        Self(status: status, type: "application/json; charset=utf-8", data: try? JSONSerialization.data(withJSONObject: object))
    }
    static func file(_ url: URL, type: String, status: Int = 200, delete: Bool = false, head: Bool = false) -> Self {
        Self(status: status, type: type, file: url, delete: delete, head: head)
    }
}

// One request per connection. Strict Content-Length framing, bounded headers,
// no chunked uploads, pipelining, CORS, external listener or arbitrary proxy.
private final class HTTPConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let handler: (HTTPRequest, @escaping (HTTPResponse) -> Void) -> Void
    private let finished: () -> Void
    private var header = Data()
    private var request: HTTPRequest?
    private var remaining = 0
    private var bodyHandle: FileHandle?
    private var responseHandle: FileHandle?
    private var responseFile: URL?
    private var closed = false
    private var timeout: DispatchWorkItem?

    init(_ connection: NWConnection, queue: DispatchQueue,
         handler: @escaping (HTTPRequest, @escaping (HTTPResponse) -> Void) -> Void, finished: @escaping () -> Void) {
        self.connection = connection; self.queue = queue; self.handler = handler; self.finished = finished
    }
    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.close() }
        }
        connection.start(queue: queue)
        let timeout = DispatchWorkItem { [weak self] in self?.close() }; self.timeout = timeout
        queue.asyncAfter(deadline: .now() + 300, execute: timeout); receive()
    }
    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            guard let self, !self.closed else { return }
            do {
                if let data { try self.consume(data) }
                if self.request != nil && self.remaining == 0 { self.dispatch(); return }
                if complete || error != nil { self.close() } else { self.receive() }
            } catch { self.send(.json(400, ["error": error.localizedDescription])) }
        }
    }
    private func consume(_ data: Data) throws {
        if request == nil {
            header.append(data)
            guard let separator = header.range(of: Data("\r\n\r\n".utf8)) else {
                if header.count > 65536 { throw TeachingError("请求头过大") }; return
            }
            guard separator.lowerBound <= 65536,
                  let text = String(data: header[..<separator.lowerBound], encoding: .utf8) else { throw TeachingError("请求头无效") }
            let lines = text.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
            guard first.count == 3 else { throw TeachingError("请求格式无效") }
            var fields: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { throw TeachingError("请求头格式无效") }
                let key = line[..<colon].lowercased()
                guard fields[key] == nil else { throw TeachingError("请求头重复") }
                fields[key] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            }
            guard fields["transfer-encoding"] == nil, let length = Int(fields["content-length"] ?? "0"),
                  length >= 0, length <= 1024 * 1024 * 1024 else { throw TeachingError("请求体过大或格式不支持") }
            remaining = length
            let file = length > 0 ? FileManager.default.temporaryDirectory.appendingPathComponent("vision-http-\(UUID().uuidString)") : nil
            if let file { FileManager.default.createFile(atPath: file.path, contents: nil); bodyHandle = try FileHandle(forWritingTo: file) }
            request = HTTPRequest(method: String(first[0]), target: String(first[1]), headers: fields, body: file)
            let rest = Data(header[separator.upperBound...]); header = Data(); try consume(rest)
        } else {
            guard data.count <= remaining else { throw TeachingError("请求体长度不一致") }
            try bodyHandle?.write(contentsOf: data); remaining -= data.count
        }
    }
    private func dispatch() {
        try? bodyHandle?.close(); bodyHandle = nil
        guard let request else { close(); return }
        handler(request) { [weak self] response in
            guard let self else { if response.delete, let file = response.file { try? FileManager.default.removeItem(at: file) }; return }
            self.queue.async { self.send(response) }
        }
    }
    private func send(_ response: HTTPResponse) {
        if response.delete { responseFile = response.file }
        guard !closed else { if let responseFile { try? FileManager.default.removeItem(at: responseFile) }; return }
        do {
            let length: Int
            if let file = response.file { length = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0; responseHandle = try FileHandle(forReadingFrom: file) }
            else { length = response.data?.count ?? 0 }
            let headers = "HTTP/1.1 \(response.status) Response\r\nContent-Type: \(response.type)\r\nContent-Length: \(length)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n"
            connection.send(content: Data(headers.utf8), completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if error != nil || response.head { self.close(); return }
                if let data = response.data { self.connection.send(content: data, completion: .contentProcessed { _ in self.close() }) }
                else { self.sendFileChunk() }
            })
        } catch { close() }
    }
    private func sendFileChunk() {
        do {
            guard let data = try responseHandle?.read(upToCount: 65536), !data.isEmpty else { close(); return }
            connection.send(content: data, completion: .contentProcessed { [weak self] error in
                if error != nil { self?.close() } else { self?.sendFileChunk() }
            })
        } catch { close() }
    }
    private func close() {
        guard !closed else { return }; closed = true; timeout?.cancel()
        try? bodyHandle?.close(); try? responseHandle?.close()
        if let file = request?.body { try? FileManager.default.removeItem(at: file) }
        if let responseFile { try? FileManager.default.removeItem(at: responseFile) }
        connection.cancel(); finished()
    }
}
