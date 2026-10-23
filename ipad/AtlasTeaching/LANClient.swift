import Foundation
import CryptoKit

struct ModelFileIdentity: Codable {
    let modelHash: String
    let byteLength: Int

    static func read(from url: URL) throws -> ModelFileIdentity {
        let file: FileHandle
        do { file = try FileHandle(forReadingFrom: url) }
        catch { throw TeachingError("无法读取 \(TeachingDevice.storageName) 本地模型文件，已停止同步；本地 Pose 仍保留") }
        defer { try? file.close() }
        var digest = SHA256(), byteLength = 0
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try Task.checkCancellation()
            byteLength += chunk.count
            guard byteLength <= maximumModelBytes else { throw TeachingError("\(TeachingDevice.storageName) 本地模型文件大小异常，已停止同步") }
            digest.update(data: chunk)
        }
        guard byteLength >= 48 else { throw TeachingError("\(TeachingDevice.storageName) 本地模型文件不完整，已停止同步") }
        return ModelFileIdentity(modelHash: digest.finalize().map { String(format: "%02x", $0) }.joined(), byteLength: byteLength)
    }
}

struct LANAddressInput {
    static let defaultPort = "21990"
    var host = ""
    var port = defaultPort
    private var scheme = "http"

    init(address: String = "") {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let explicitScheme = text.contains("://")
        guard let parts = URLComponents(string: explicitScheme ? text : "http://\(text)"),
              let host = parts.host, !host.isEmpty, ["http", "https"].contains(parts.scheme),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { self.host = text; return }
        self.host = host; scheme = parts.scheme ?? "http"
        // Preserve an explicit URL's standard port when reopening older projects.
        port = parts.port.map(String.init) ?? (explicitScheme ? (scheme == "https" ? "443" : "80") : Self.defaultPort)
    }
    var effectivePort: String {
        let value = port.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? Self.defaultPort : value
    }
    var displayAddress: String { "\(host):\(effectivePort)" }
    var address: String {
        let host = host.trimmingCharacters(in: .whitespacesAndNewlines)
        return host.isEmpty ? "" : "\(scheme)://\(host):\(effectivePort)"
    }
    var canConnect: Bool {
        guard effectivePort.utf8.allSatisfy({ (48...57).contains($0) }),
              let port = Int(effectivePort), (1...65535).contains(port),
              let client = try? LANClient(address: address) else { return false }
        return client.baseURL.host?.lowercased() == host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct LANServiceInfo: Decodable {
    let `protocol`: String
    let serverId: String
    let serverName: String
    let port: Int
}

struct VisionPairingOffer: Decodable, Identifiable {
    let sessionId: String
    let name: String
    let code: String
    let expiresAt: Double
    var id: String { sessionId }
    var isExpired: Bool { expiresAt <= Date().timeIntervalSince1970 * 1000 }
}

struct PairingQRCode: Decodable {
    let `protocol`: String
    let address: String
    let code: String
    let sessionId: String
    let serverId: String
    let expiresAt: Double
    var purpose: String? = nil
    var isScreen: Bool { purpose == "screen" }

    static func parse(_ text: String) throws -> PairingQRCode {
        guard text.utf8.count <= 2048, let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(Self.self, from: data) else {
            throw TeachingError("这不是 Atlas 二维码，请扫描电脑「iPad / Vision Pro」窗口中的二维码")
        }
        try value.validate()
        return value
    }
    func validate() throws {
        guard self.protocol == "atlas-ipad-pairing/1", purpose == nil || purpose == "screen", PairingCode.isValid(code),
              UUID(uuidString: sessionId) != nil, UUID(uuidString: serverId) != nil, expiresAt.isFinite else {
            throw TeachingError("二维码格式不支持，请在电脑上更新配对码后重新扫描")
        }
        _ = try LANClient(address: address)
        guard expiresAt > Date().timeIntervalSince1970 * 1000 else {
            throw TeachingError("二维码已过期，请在电脑点击「更新配对码」后重新扫描")
        }
    }
}

struct ScreenPairedSession: Decodable {
    let `protocol`: String
    let id: String
    let serverId: String
    let deviceToken: String
}

struct ModelDownloadProgress: Sendable {
    let receivedBytes: Int64
    let totalBytes: Int64
    var fractionCompleted: Double { min(1, max(0, Double(receivedBytes) / Double(max(1, totalBytes)))) }
}

private class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

// URLSession invokes these callbacks on its serial delegate queue. Limit UI
// updates to ten per second without buffering the model in memory as it arrives.
private final class ModelDownloadDelegate: NoRedirects, URLSessionDownloadDelegate, @unchecked Sendable {
    let expectedBytes: Int64
    let onProgress: @Sendable (ModelDownloadProgress) -> Void
    private var lastUpdate = -Double.infinity
    private let lock = NSLock()
    private var task: URLSessionDownloadTask?
    private var cancelled = false
    private var continuation: CheckedContinuation<(Data, URLResponse), Error>?
    // Only accessed on URLSession's serial delegate queue.
    private var downloaded: Result<(Data, URLResponse), Error>?

    init(expectedBytes: Int64, onProgress: @escaping @Sendable (ModelDownloadProgress) -> Void) {
        self.expectedBytes = expectedBytes; self.onProgress = onProgress
    }
    func download(_ request: URLRequest, configuration: URLSessionConfiguration) async throws -> (Data, URLResponse) {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                self.continuation = continuation
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
                let task = session.downloadTask(with: request)
                self.task = task
                let cancelled = self.cancelled
                lock.unlock()
                if cancelled { task.cancel() }
                task.resume()
            }
        } onCancel: {
            self.lock.lock()
            self.cancelled = true
            let task = self.task
            self.lock.unlock()
            task?.cancel()
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard let response = downloadTask.response as? HTTPURLResponse, (200...299).contains(response.statusCode) else { return }
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastUpdate >= 0.1 || totalBytesWritten >= expectedBytes else { return }
        lastUpdate = now
        // The paired manifest also supplies a total for chunked HTTP responses.
        onProgress(ModelDownloadProgress(receivedBytes: totalBytesWritten, totalBytes: expectedBytes))
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        downloaded = Result {
            guard let response = downloadTask.response else { throw TeachingError("局域网服务未返回有效响应") }
            let size = try location.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size <= maximumModelBytes else { throw TeachingError("物体超过 移动端传输上限（192 MiB）") }
            // URLSession removes its temporary file after this callback returns.
            return (try Data(contentsOf: location), response)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil; self.task = nil
        lock.unlock()
        defer { session.finishTasksAndInvalidate() }
        if let error { continuation?.resume(throwing: error) }
        else { continuation?.resume(with: downloaded ?? .failure(TeachingError("模型下载未完成，请重试"))) }
    }
}

struct LANClient {
    let baseURL: URL
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.allowsCellularAccess = false; config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 300
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }()
    init(address: String) throws {
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text.contains("://") ? text : "http://\(text)"),
              ["http", "https"].contains(url.scheme), let host = url.host,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw TeachingError("请检查电脑的 IPv4 地址与端口，例如 192.168.1.20，端口 21990") }
        guard url.port == nil || (1...65535).contains(url.port!) else { throw TeachingError("局域网端口无效") }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        let octets = parts.compactMap { Int($0) }
        let ipv4 = parts.count == 4 && octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
            && parts.allSatisfy { !$0.isEmpty && $0.utf8.allSatisfy { (48...57).contains($0) } }
        let localIPv4 = ipv4 && (octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168)
            || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 169 && octets[1] == 254))
        guard localIPv4 || host.hasSuffix(".local") || host == "localhost" else { throw TeachingError("仅支持局域网 IPv4 地址或 .local 主机名") }
        baseURL = url
    }
    private func request(_ path: String, token: String? = nil, method: String = "GET", body: Data? = nil) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent("__atlas/ipad/\(path)"))
        request.httpMethod = method; request.httpBody = body
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }
    private func check(_ response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
            struct ErrorResponse: Decodable { var error: String }
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data))?.error
            throw TeachingError(message ?? "局域网服务未返回有效响应，请检查电脑地址和网络")
        }
    }
    // Discovery is read-only and bounded; another HTTP service is never a match.
    func identify() async throws -> LANServiceInfo {
        var request = request("info")
        request.timeoutInterval = 3
        let (bytes, response) = try await Self.session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.expectedContentLength <= 16_384 else { throw TeachingError("不是可用的 Atlas 示教服务") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 16_384 else { throw TeachingError("服务信息过大") }
            data.append(byte)
        }
        let info = try JSONDecoder().decode(LANServiceInfo.self, from: data)
        guard info.protocol == teachingProtocol, UUID(uuidString: info.serverId) != nil,
              !info.serverName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, info.serverName.count <= 120,
              info.port == (baseURL.port ?? (baseURL.scheme == "https" ? 443 : 80)) else {
            throw TeachingError("不是兼容的 Atlas 示教服务")
        }
        return info
    }
    func visionPairingOffers(serverID: String) async throws -> [VisionPairingOffer] {
        var request = request("vision-pairing")
        request.timeoutInterval = 5
        let (bytes, response) = try await Self.session.bytes(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 404 {
            throw TeachingError("电脑服务尚不支持自动填码，请更新电脑服务或手动输入配对码。")
        }
        guard (response as? HTTPURLResponse)?.statusCode == 200, response.expectedContentLength <= 32_768 else {
            throw TeachingError("暂时无法获取配对码，请确认电脑配对窗口已打开，再重试。")
        }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 32_768 else { throw TeachingError("电脑返回的配对信息过大") }
            data.append(byte)
        }
        struct Response: Decodable {
            let `protocol`: String
            let serverId: String
            let offers: [VisionPairingOffer]
        }
        let result = try JSONDecoder().decode(Response.self, from: data)
        guard result.protocol == teachingProtocol, result.serverId == serverID, UUID(uuidString: serverID) != nil,
              result.offers.count <= 16, Set(result.offers.map(\.id)).count == result.offers.count,
              result.offers.allSatisfy({ UUID(uuidString: $0.id) != nil && PairingCode.isValid($0.code)
                  && !$0.name.isEmpty && $0.name.count <= 240 && $0.expiresAt.isFinite }) else {
            throw TeachingError("配对信息与所选电脑不匹配，请重新检测电脑。")
        }
        return result.offers.filter { !$0.isExpired }
    }
    func pair(code: String, deviceID: String, name: String, qr: PairingQRCode? = nil) async throws -> PairedSession {
        let code = PairingCode.normalize(code)
        guard PairingCode.isValid(code) else { throw TeachingError("请输入 4 位配对码，仅支持大写字母 A–Z 和数字 0–9") }
        var fields = ["code": code, "deviceId": deviceID, "deviceName": name]
        if let qr {
            try qr.validate()
            guard !qr.isScreen else { throw TeachingError("这是画面协作二维码，请从首页扫码连接。") }
            guard try LANClient(address: qr.address).baseURL == baseURL, PairingCode.normalize(qr.code) == code else {
                throw TeachingError("二维码配对信息已变更，请重新扫描")
            }
            let info = try await identify()
            guard info.serverId == qr.serverId else { throw TeachingError("电脑服务已重启或地址已变更，请重新打开电脑配对窗口并扫码") }
            fields["sessionId"] = qr.sessionId; fields["serverId"] = qr.serverId
        }
        let body = try JSONSerialization.data(withJSONObject: fields)
        let (data, response) = try await Self.session.data(for: request("pair", method: "POST", body: body))
        try check(response, data: data)
        let paired = try JSONDecoder().decode(PairedSession.self, from: data)
        if let qr, paired.id != qr.sessionId { throw TeachingError("接收任务与二维码不匹配，请重新扫描") }
        return paired
    }
    func pairScreen(code: String, deviceID: String, name: String, qr: PairingQRCode? = nil) async throws -> ScreenPairedSession {
        let code = PairingCode.normalize(code)
        guard PairingCode.isValid(code) else { throw TeachingError("请输入电脑画面协作窗口中的 4 位配对码") }
        let info = try await identify()
        var fields = ["code": code, "deviceId": deviceID, "deviceName": name, "serverId": info.serverId]
        if let qr {
            try qr.validate()
            guard qr.isScreen, try LANClient(address: qr.address).baseURL == baseURL, qr.code == code,
                  qr.serverId == info.serverId else { throw TeachingError("协作二维码与电脑不匹配，请重新扫码") }
            fields["sessionId"] = qr.sessionId
        }
        var request = URLRequest(url: baseURL.appendingPathComponent("__atlas/ipad-screen/pair"))
        request.httpMethod = "POST"; request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: fields)
        let (bytes, response) = try await Self.session.bytes(for: request)
        var data = Data()
        for try await byte in bytes {
            guard data.count < 16384 else { throw TeachingError("协作配对信息过大") }
            data.append(byte)
        }
        try check(response, data: data)
        let paired = try JSONDecoder().decode(ScreenPairedSession.self, from: data)
        guard paired.protocol == "atlas-ipad-screen/1", UUID(uuidString: paired.id) != nil,
              paired.serverId == info.serverId, qr == nil || qr?.sessionId == paired.id,
              paired.deviceToken.count == 64, paired.deviceToken.allSatisfy({ "0123456789abcdef".contains($0) }) else {
            throw TeachingError("协作配对响应无效，请重新连接")
        }
        return paired
    }
    func screenSocket(_ paired: ScreenPairedSession) throws -> URLSessionWebSocketTask {
        var url = URLComponents(url: baseURL.appendingPathComponent("__atlas/ipad-screen/session/\(paired.id)/device"), resolvingAgainstBaseURL: false)!
        url.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        guard let address = url.url else { throw TeachingError("协作地址无效") }
        var request = URLRequest(url: address); request.timeoutInterval = 8
        request.setValue("Bearer \(paired.deviceToken)", forHTTPHeaderField: "Authorization")
        let socket = Self.session.webSocketTask(with: request)
        socket.maximumMessageSize = 2 * 1024 * 1024 + 5
        return socket
    }
    func download(_ paired: PairedSession, onProgress: @escaping @Sendable (ModelDownloadProgress) -> Void = { _ in }) async throws -> Data {
        guard UUID(uuidString: paired.id) != nil else { throw TeachingError("配对任务标识无效") }
        guard (48...maximumModelBytes).contains(paired.manifest.byteLength) else { throw TeachingError("模型清单或文件大小无效") }
        let total = Int64(paired.manifest.byteLength)
        onProgress(ModelDownloadProgress(receivedBytes: 0, totalBytes: total))
        let delegate = ModelDownloadDelegate(expectedBytes: total, onProgress: onProgress)
        let (data, response) = try await delegate.download(request("sessions/\(paired.id)/model", token: paired.deviceToken), configuration: Self.session.configuration)
        try check(response, data: data)
        guard data.count == paired.manifest.byteLength else { throw TeachingError("模型文件不完整，请重新下载") }
        try Task.checkCancellation()
        onProgress(ModelDownloadProgress(receivedBytes: Int64(data.count), totalBytes: total))
        return data
    }
    func modelThumbnail(_ paired: PairedSession) async throws -> Data {
        guard UUID(uuidString: paired.id) != nil else { throw TeachingError("配对任务标识无效") }
        let (bytes, response) = try await Self.session.bytes(for: request("sessions/\(paired.id)/thumbnail", token: paired.deviceToken))
        guard response.expectedContentLength <= 512 * 1024 else { throw TeachingError("模型预览过大") }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < 512 * 1024 else { throw TeachingError("模型预览过大") }
            data.append(byte)
        }
        try check(response, data: data)
        guard let http = response as? HTTPURLResponse,
              http.value(forHTTPHeaderField: "X-Model-SHA256") == paired.manifest.modelHash,
              data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { throw TeachingError("模型预览与当前任务不匹配") }
        return data
    }
    func pairResult(_ project: LocalProject, modelURL: URL, qr: PairingQRCode, deviceID: String, name: String) async throws -> PairedSession {
        try qr.validate()
        guard !qr.isScreen else { throw TeachingError("这是画面协作二维码，请使用示教同步窗口的二维码。") }
        guard try LANClient(address: qr.address).baseURL == baseURL else { throw TeachingError("二维码地址已变更，请重新扫描") }
        let identity = try await verifiedLocalModel(project, modelURL: modelURL)
        let info = try await identify()
        guard info.serverId == qr.serverId else { throw TeachingError("电脑服务已重启或地址已变更，请重新打开电脑窗口并扫码") }
        struct PairResult: Encodable {
            var code: String; var sessionId: String; var serverId: String
            var deviceId: String; var deviceName: String; var resultId: String; var modelIdentity: ModelFileIdentity
        }
        let body = PairResult(code: PairingCode.normalize(qr.code), sessionId: qr.sessionId, serverId: qr.serverId,
            deviceId: deviceID, deviceName: name, resultId: project.result.id, modelIdentity: identity)
        let (data, response) = try await Self.session.data(for: request("pair-result", method: "POST", body: try JSONEncoder().encode(body)))
        try check(response, data: data)
        let destination = try JSONDecoder().decode(PairedSession.self, from: data)
        guard destination.id == qr.sessionId else { throw TeachingError("同步任务与二维码不匹配，请重新扫描") }
        try validateDestination(destination, identity: identity)
        return destination
    }
    private func verifiedLocalModel(_ project: LocalProject, modelURL: URL) async throws -> ModelFileIdentity {
        guard project.result.completedAt != nil, !project.result.samples.isEmpty else { throw TeachingError("示教尚未完成") }
        guard project.result.device.platform != "visionOS-simulator" else { throw TeachingError("模拟演练数据只能保存在本机，不能同步") }
        guard UUID(uuidString: project.id) != nil, project.result.sessionId == project.id else { throw TeachingError("本地模型与配对任务不匹配，已停止同步") }
        let identity = try await Task.detached { try ModelFileIdentity.read(from: modelURL) }.value
        try Task.checkCancellation()
        guard identity.modelHash == project.session.manifest.modelHash,
              identity.byteLength == project.session.manifest.byteLength,
              identity.modelHash == project.result.modelHash else {
            throw TeachingError("\(TeachingDevice.storageName) 本地模型内容与配对时不一致，已停止同步；请恢复原模型，本地 Pose 仍保留")
        }
        return identity
    }
    private func validateDestination(_ destination: PairedSession, identity: ModelFileIdentity) throws {
        let manifest = destination.manifest
        guard UUID(uuidString: destination.id) != nil, !destination.deviceToken.isEmpty,
              manifest.protocol == teachingProtocol, manifest.coordinateFrame == "virtual_origin",
              manifest.distanceUnit == "meter", manifest.verticalAxis == "Z",
              manifest.modelHash == identity.modelHash, manifest.byteLength == identity.byteLength else {
            throw TeachingError("电脑同步任务与本地模型不匹配，已停止同步；本地 Pose 仍保留")
        }
    }
    func upload(_ project: LocalProject, modelURL: URL, onModelVerified: @MainActor () -> Void = {}) async throws {
        let identity = try await verifiedLocalModel(project, modelURL: modelURL)
        let destination = project.resultSyncDestination?.session ?? project.session
        try validateDestination(destination, identity: identity)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        // Send only the model fingerprint first. No poses are sent until both files match.
        let (verificationData, verificationResponse) = try await Self.session.data(for: request("sessions/\(destination.id)/verify-model",
            token: destination.deviceToken, method: "POST", body: try encoder.encode(identity)))
        try check(verificationResponse, data: verificationData)
        struct Verification: Decodable { var sessionId: String; var modelHash: String; var byteLength: Int; var verified: Bool }
        let verification = try JSONDecoder().decode(Verification.self, from: verificationData)
        guard verification.verified, verification.sessionId == destination.id,
              verification.modelHash == identity.modelHash, verification.byteLength == identity.byteLength else {
            throw TeachingError("电脑返回的模型校验结果不匹配，已停止同步；本地 Pose 仍保留")
        }
        try Task.checkCancellation()
        await onModelVerified()
        // Only the transport session changes. Preserve the result ID for browser
        // deduplication and keep the original local result/Pose bytes untouched.
        var result = project.result; result.sessionId = destination.id
        let (data, response) = try await Self.session.data(for: request("sessions/\(destination.id)/result", token: destination.deviceToken,
            method: "POST", body: try encoder.encode(result)))
        try check(response, data: data)
        struct Receipt: Decodable { var id: String; var received: Bool; var sampleCount: Int }
        let receipt = try JSONDecoder().decode(Receipt.self, from: data)
        guard receipt.received, receipt.id == project.result.id, receipt.sampleCount == project.result.samples.count else { throw TeachingError("同步回执与示教结果不匹配") }
    }
}
