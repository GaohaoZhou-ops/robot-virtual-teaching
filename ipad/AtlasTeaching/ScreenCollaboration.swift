import SwiftUI
import Network
import UIKit
import ImageIO

private let screenProtocol = "atlas-ipad-screen/1"
private let screenAccent = Color(red: 0.35, green: 0.86, blue: 0.91)

struct ScreenJoint: Decodable, Identifiable, Equatable {
    let name: String
    let group: String
    let lower: Double
    let upper: Double
    let step: Double
    let unit: String
    let value: Double
    var id: String { name }
    func formatted(_ value: Double) -> String { String(format: unit == "m" ? "%.3f" : "%.1f", value) }
}

struct ScreenJointState: Decodable, Equatable {
    let robotId: String
    let robotName: String
    let editable: Bool
    let reason: String
    let ack: Int
    let joints: [ScreenJoint]
    let capture: ScreenPoseCaptureState?
    let captureResult: ScreenPoseCaptureResult?
    let viewportControl: ScreenViewportControl?
    var valid: Bool {
        !robotId.isEmpty && robotId.count <= 256 && robotName.count <= 256 && reason.count <= 256 && ack >= 0
        && (capture?.valid ?? true) && (captureResult?.valid ?? true) && (viewportControl?.valid ?? true)
        && joints.count <= 128 && Set(joints.map(\.name)).count == joints.count
        && joints.allSatisfy { joint in
            !joint.name.isEmpty && joint.name.count <= 128 && joint.group.count <= 64 && ["m", "°"].contains(joint.unit)
            && [joint.lower, joint.upper, joint.step, joint.value].allSatisfy { $0.isFinite && abs($0) <= 1e7 }
            && joint.lower <= joint.upper && joint.step > 0
        }
    }
}

struct ScreenViewportControl: Decodable, Equatable {
    let enabled: Bool
    let aspect: Double
    let ack: Int
    var valid: Bool { aspect.isFinite && aspect >= 0.01 && aspect <= 100 && ack >= 0 }
}

private struct ScreenViewportCommand {
    let sequence: Int
    let kind: String
    let dx: Double
    let dy: Double
    let zoom: Double
    let created: Date
}

struct ScreenPoseCaptureState: Decodable, Equatable {
    let taskId: String
    let parkingPointId: String
    let taskName: String
    let parkingPointName: String
    let reason: String
    var valid: Bool { [taskId, parkingPointId, taskName, parkingPointName, reason].allSatisfy { $0.count <= 256 } }
}

struct ScreenPoseCaptureResult: Decodable, Equatable {
    let id: String
    let status: String
    let message: String
    var valid: Bool { UUID(uuidString: id) != nil && ["recording", "complete", "error"].contains(status) && message.count <= 512 }
}

private struct ScreenPoseCaptureRequest {
    let id = UUID().uuidString
    let robotId: String
    let taskId: String
    let parkingPointId: String
    let created = Date()
}

private struct ScreenJointCommand {
    let sequence: Int
    let name: String
    let value: Double
    let created: Date
}

private struct ScreenCollaborationActiveKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var screenCollaborationActive: Bool {
        get { self[ScreenCollaborationActiveKey.self] }
        set { self[ScreenCollaborationActiveKey.self] = newValue }
    }
}

struct ScreenUSBInvitation: Identifiable {
    let id: String
    let outgoing: Bool
    let computerName: String
    let expiresAt: Date
    var status = "pending"
    var token = ""
}

/// The listener is loopback-only: the paired computer reaches it through USB
/// multiplexing. It is never advertised on Bonjour or exposed on Wi-Fi.
@MainActor
final class ScreenCollaboration: ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var stale = true
    @Published private(set) var left: UIImage?
    @Published private(set) var right: UIImage?
    @Published private(set) var workspace: ScreenJointState?
    @Published private(set) var viewport: UIImage?
    @Published private(set) var controlsStale = true
    @Published private(set) var controlMessage = ""
    @Published private var pending: [String: ScreenJointCommand] = [:]
    @Published private var pendingCapture: ScreenPoseCaptureRequest?
    @Published private(set) var captureMessage = ""
    @Published var captureNotice: String?
    private var captureAccepted = false
    private var pendingViewport: [ScreenViewportCommand] = []
    private var viewportSequence = 0
    private var viewportSentSequence = 0
    @Published var page = "cameras" {
        didSet { if page != oldValue { publishUSBControls() } }
    }
    @Published private(set) var connecting = false
    @Published private(set) var connectionError = ""
    @Published private(set) var connectionKind = "USB"
    @Published private(set) var usbInvitation: ScreenUSBInvitation?
    @Published private(set) var usbInvitationMessage = ""
    var awaitingUSBInvitation: Bool { usbInvitation?.status == "pending" }
    var incomingUSBInvitation: ScreenUSBInvitation? {
        guard let invitation = usbInvitation, !invitation.outgoing, invitation.status == "pending" else { return nil }
        return invitation
    }

    func inviteUSBComputer() {
        guard !active, !connecting, !awaitingUSBInvitation else { return }
        usbInvitation = ScreenUSBInvitation(id: UUID().uuidString.lowercased(), outgoing: true,
            computerName: "电脑", expiresAt: Date().addingTimeInterval(60))
        usbInvitationMessage = "已发出邀请，等待电脑确认（60 秒内有效）。请保持数据线连接，并在电脑打开示教工作台。"
        connectionError = ""
    }

    func cancelUSBInvitation() {
        guard awaitingUSBInvitation else { return }
        usbInvitation?.status = "cancelled"
        usbInvitationMessage = "邀请已取消，可以重新发起。"
    }

    func respondToUSBInvitation(id: String, accept: Bool) {
        expireUSBInvitation()
        guard let invitation = incomingUSBInvitation, invitation.id == id else { return }
        usbInvitation?.status = accept ? "accepted" : "rejected"
        usbInvitationMessage = accept ? "已接受邀请，正在等待电脑画面…" : "已拒绝电脑的协作邀请。"
        if accept { beginSession(token: invitation.token) }
    }

    private func expireUSBInvitation() {
        if let invitation = usbInvitation, invitation.status == "pending", Date() >= invitation.expiresAt {
            usbInvitation?.status = "expired"
            usbInvitationMessage = "邀请已过期，请重新发起协作。"
        }
    }

    private func beginSession(token candidate: String) {
        token = candidate; receivedFrames = 0; lastFrame = Date(); lastContact = lastFrame; stale = true
        previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        connecting = false; connectionError = ""; active = true
    }
    private var networkSocket: URLSessionWebSocketTask?
    private var networkTask: Task<Void, Never>?
    private var networkToken = ""
    private var networkGeneration = UUID()
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var connectionActivity: [UUID: Date] = [:]
    private var usbControls: NWConnection?
    private var usbControlsID: UUID?
    private var usbControlsBusy = false
    private var usbControlsDirty = false
    private var usbControlsScheduled = false
    private var token = ""
    private var lastFrame = Date.distantPast
    private var lastContact = Date.distantPast
    private var timer: Timer?
    private var receivedFrames = 0
    private var previousIdleTimerDisabled = false
    private var lastWorkspace = Date.distantPast
    private var sequence = 0
    private var viewportFrames = 0
    private var leftData: Data?
    private var rightData: Data?
    private var viewportData: Data?
    var canControl: Bool { active && !controlsStale && workspace?.editable == true && !awaitingCapture }
    var awaitingControl: Bool { !pending.isEmpty }
    var awaitingCapture: Bool { pendingCapture != nil }
    var canNavigateViewport: Bool {
        active && page == "joints" && !controlsStale && viewport != nil && workspace?.viewportControl?.enabled == true
    }
    var viewportUnavailableReason: String? {
        guard active, workspace != nil, viewport != nil else { return "正在同步三维画面…" }
        if controlsStale { return "显示最近姿态 · 等待电脑更新" }
        guard let control = workspace?.viewportControl else {
            return "电脑页面版本较旧，请刷新工作台后重新连接协作。"
        }
        return control.enabled ? nil : "电脑三维视图暂不可操作，请在电脑端检查三维窗口。"
    }

    func navigateViewport(kind: String, dx: Double = 0, dy: Double = 0, zoom: Double = 0) {
        guard canNavigateViewport, ["rotate", "pan", "zoom"].contains(kind),
              [dx, dy, zoom].allSatisfy({ $0.isFinite && abs($0) <= 4 }),
              abs(dx) + abs(dy) + abs(zoom) > 1e-8 else { return }
        pendingViewport.removeAll { Date().timeIntervalSince($0.created) >= 3 }
        guard pendingViewport.count < 128 else { return }
        viewportSequence += 1
        // Only merge motions that have never been sent. Once sent, their
        // sequence and delta remain immutable until the computer acknowledges.
        if let last = pendingViewport.last, last.sequence > viewportSentSequence, last.kind == kind,
           [last.dx + dx, last.dy + dy, last.zoom + zoom].allSatisfy({ abs($0) <= 4 }) {
            pendingViewport.removeLast()
            pendingViewport.append(ScreenViewportCommand(sequence: viewportSequence, kind: kind,
                dx: last.dx + dx, dy: last.dy + dy, zoom: last.zoom + zoom, created: last.created))
        } else {
            pendingViewport.append(ScreenViewportCommand(sequence: viewportSequence, kind: kind, dx: dx, dy: dy, zoom: zoom, created: Date()))
        }
        publishUSBControls()
    }

    func recordPose() {
        guard !awaitingCapture else { return }
        guard active, !controlsStale, let state = workspace else {
            captureNotice = "电脑姿态尚未同步，请等待画面恢复后再记录。"; return
        }
        guard let capture = state.capture else {
            captureNotice = "请更新并刷新网页端，再重新连接协作。"; return
        }
        guard capture.reason.isEmpty else { captureNotice = capture.reason; return }
        guard !awaitingControl else { captureNotice = "关节正在同步，请稍候再记录姿态。"; return }
        captureAccepted = false; captureMessage = "正在记录姿态…"; captureNotice = nil
        pendingCapture = ScreenPoseCaptureRequest(robotId: state.robotId, taskId: capture.taskId, parkingPointId: capture.parkingPointId)
        publishUSBControls()
    }

    func jointValue(_ joint: ScreenJoint) -> Double { pending[joint.name]?.value ?? joint.value }

    func changeJoint(_ joint: ScreenJoint, value: Double) {
        guard canControl, value.isFinite else { return }
        let value = min(joint.upper, max(joint.lower, value))
        guard abs(jointValue(joint) - value) > 1e-8 else { return }
        sequence += 1; controlMessage = ""
        pending[joint.name] = ScreenJointCommand(sequence: sequence, name: joint.name, value: value, created: Date())
        publishUSBControls()
    }

    private func expireCommands() {
        pendingViewport.removeAll { Date().timeIntervalSince($0.created) >= 3 }
        let fresh = pending.filter { Date().timeIntervalSince($0.value.created) < 3 }
        if fresh.count != pending.count { pending = fresh; controlMessage = "操作未同步，请在画面恢复后重试。" }
        if let capture = pendingCapture, !captureAccepted, Date().timeIntervalSince(capture.created) > 8 {
            pendingCapture = nil; captureMessage = ""
            captureNotice = "记录请求超时，请先在网页端确认记录结果后重试。"
        }
    }

    private func collaborationStatus() -> [String: Any] {
        expireCommands()
        let commands: [[String: Any]] = pending.values.sorted { $0.sequence < $1.sequence }.prefix(32).map { command in
            ["sequence": command.sequence, "robotId": workspace?.robotId ?? "", "name": command.name,
             "value": command.value, "ageMs": max(0, Date().timeIntervalSince(command.created) * 1000)]
        }
        var status: [String: Any] = ["page": page, "commands": commands]
        let motions = Array(pendingViewport.prefix(32))
        if let sequence = motions.last?.sequence { viewportSentSequence = max(viewportSentSequence, sequence) }
        status["viewportCommands"] = motions.map { command in
            ["sequence": command.sequence, "robotId": workspace?.robotId ?? "", "kind": command.kind,
             "dx": command.dx, "dy": command.dy, "zoom": command.zoom,
             "ageMs": max(0, Date().timeIntervalSince(command.created) * 1000)] as [String: Any]
        }
        if let capture = pendingCapture, !captureAccepted {
            status["captureRequest"] = ["id": capture.id, "robotId": capture.robotId, "taskId": capture.taskId,
                "parkingPointId": capture.parkingPointId, "ageMs": max(0, Date().timeIntervalSince(capture.created) * 1000)]
        }
        return status
    }

    // Coalesce only unsent input, independently of JPEG acknowledgements. There
    // is never more than one network send and one pending latest status.
    private func publishUSBControls() {
        guard active, let connection = usbControls else { return }
        usbControlsDirty = true
        guard !usbControlsBusy, !usbControlsScheduled else { return }
        usbControlsScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self, weak connection] in
            guard let self, let connection, self.usbControls === connection else { return }
            self.usbControlsScheduled = false
            guard self.active, !self.usbControlsBusy else { return }
            guard var bytes = try? JSONSerialization.data(withJSONObject: self.collaborationStatus()), bytes.count <= 65535 else { return }
            bytes.append(10)
            self.usbControlsDirty = false
            self.usbControlsBusy = true
            connection.send(content: bytes, completion: .contentProcessed { [weak self, weak connection] error in
                MainActor.assumeIsolated {
                    guard let self, let connection, self.usbControls === connection else { return }
                    self.usbControlsBusy = false
                    if error != nil { connection.cancel() }
                    else if self.usbControlsDirty { self.publishUSBControls() }
                }
            })
        }
    }

    func connect(address: String, code: String, deviceID: String, qr: PairingQRCode? = nil) async {
        guard !active, !connecting, !awaitingUSBInvitation else { return }
        connecting = true; connectionError = ""; lastContact = Date()
        let generation = UUID(); networkGeneration = generation
        do {
            let client = try LANClient(address: qr?.address ?? address)
            let paired = try await client.pairScreen(code: qr?.code ?? code, deviceID: deviceID, name: UIDevice.current.name, qr: qr)
            guard networkGeneration == generation, connecting else { return }
            UserDefaults.standard.set(client.baseURL.absoluteString, forKey: "serverAddress")
            let socket = try client.screenSocket(paired)
            networkSocket = socket; networkToken = paired.deviceToken; connectionKind = "Wi-Fi"
            socket.resume()
            networkTask = Task { [weak self] in
                do {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        guard let self, self.networkGeneration == generation, self.networkSocket === socket else { return }
                        guard case let .data(data) = message, data.count >= 5 else { throw TeachingError("电脑协作数据无效") }
                        let id = data[1..<5].reduce(0) { ($0 << 8) | Int($1) }
                        let actions: [UInt8: (String, String)] = [1: ("POST", "/session"), 2: ("PUT", "/frame"),
                            3: ("PUT", "/workspace"), 4: ("PUT", "/heartbeat"), 5: ("DELETE", "/session")]
                        guard let (method, path) = actions[data[0]] else { throw TeachingError("电脑协作请求无效") }
                        var reply: [String: Any] = [:]
                        await self.process(method: method, path: path, authorization: "Bearer \(paired.deviceToken)", body: Data(data.dropFirst(5))) {
                            reply = ["requestId": id, "status": $0, "body": $1]
                        }
                        guard self.networkSocket === socket else { return }
                        let response = try JSONSerialization.data(withJSONObject: reply)
                        try await socket.send(.string(String(decoding: response, as: UTF8.self)))
                    }
                } catch {
                    guard let self, self.networkGeneration == generation else { return }
                    self.finish(); self.connectionError = "Wi-Fi 协作已断开，请检查电脑服务与网络后重新配对。"
                }
            }
        } catch {
            guard networkGeneration == generation else { return }
            finish(); connectionError = error.localizedDescription
        }
    }

    func start() {
        guard listener == nil else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: 21991)
        parameters.allowLocalEndpointReuse = true
        guard let server = try? NWListener(using: parameters) else { return }
        listener = server
        server.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.accept(connection) }
        }
        server.stateUpdateHandler = { [weak self, weak server] state in
            MainActor.assumeIsolated {
                if case .failed = state, self?.listener === server { self?.stop() }
            }
        }
        server.start(queue: .main)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.expireUSBInvitation()
                for (id, lastActivity) in self.connectionActivity where id != self.usbControlsID && Date().timeIntervalSince(lastActivity) > 8 {
                    self.connections[id]?.cancel()
                }
                guard self.active || self.connecting else { return }
                let stale = self.page == "joints"
                    ? self.viewport == nil || Date().timeIntervalSince(self.lastWorkspace) > 2.5
                    : self.left == nil || Date().timeIntervalSince(self.lastFrame) > 2.5
                if self.stale != stale { self.stale = stale }
                let controlsStale = Date().timeIntervalSince(self.lastWorkspace) > 2.5
                if self.controlsStale != controlsStale { self.controlsStale = controlsStale }
                self.expireCommands()
                self.publishUSBControls()
                if Date().timeIntervalSince(self.lastContact) > 10 {
                    let wireless = self.connecting || self.connectionKind == "Wi-Fi"
                    self.finish()
                    if wireless { self.connectionError = "电脑连接超时，请检查网络后重新配对。" }
                }
            }
        }
    }

    func stop() {
        listener?.cancel(); listener = nil
        timer?.invalidate(); timer = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        finish()
    }

    func finish() {
        networkGeneration = UUID(); networkTask?.cancel(); networkTask = nil
        networkSocket?.cancel(with: .normalClosure, reason: nil); networkSocket = nil; networkToken = ""
        connecting = false; connectionError = ""; connectionKind = "USB"
        usbInvitation = nil; usbInvitationMessage = ""
        if active { UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled }
        active = false; stale = true; token = ""; left = nil; right = nil
        usbControls?.cancel(); usbControls = nil; usbControlsID = nil
        usbControlsBusy = false; usbControlsDirty = false; usbControlsScheduled = false
        workspace = nil; viewport = nil; pending = [:]; sequence = 0; viewportFrames = 0
        pendingCapture = nil; captureAccepted = false; captureMessage = ""; captureNotice = nil
        pendingViewport = []; viewportSequence = 0; viewportSentSequence = 0
        controlsStale = true; controlMessage = ""; page = "cameras"; lastWorkspace = .distantPast
        leftData = nil; rightData = nil; viewportData = nil
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 4 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connectionActivity[id] = Date()
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            MainActor.assumeIsolated {
                guard let self, let connection else { return }
                switch state {
                case .failed, .cancelled:
                    self.connections.removeValue(forKey: id); self.connectionActivity.removeValue(forKey: id)
                    if self.usbControls === connection {
                        self.usbControls = nil; self.usbControlsID = nil
                        self.usbControlsBusy = false; self.usbControlsDirty = false; self.usbControlsScheduled = false
                    }
                    connection.cancel()
                default: break
                }
            }
        }
        connection.start(queue: .main)
        receive(connection, id: id, buffer: Data())
    }

    private func receive(_ connection: NWConnection, id: UUID, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, self.connections[id] != nil else { return }
                self.connectionActivity[id] = Date()
                var bytes = buffer
                if let data { bytes.append(data) }
                guard bytes.count <= 2 * 1024 * 1024 + 8192 else {
                    self.reply(connection, id: id, status: 413, value: ["error": "画面数据过大"]); return
                }
                if let end = bytes.range(of: Data("\r\n\r\n".utf8)) {
                    guard end.upperBound <= 8192,
                          let header = String(data: bytes[..<end.lowerBound], encoding: .utf8) else {
                        self.reply(connection, id: id, status: 400, value: ["error": "请求无效"]); return
                    }
                    let lines = header.components(separatedBy: "\r\n")
                    let parts = lines[0].split(separator: " ")
                    var headers: [String: String] = [:]
                    for line in lines.dropFirst() {
                        let fields = line.split(separator: ":", maxSplits: 1)
                        if fields.count == 2 { headers[String(fields[0]).lowercased()] = fields[1].trimmingCharacters(in: .whitespaces) }
                    }
                    guard parts.count == 3, let length = Int(headers["content-length"] ?? "0"),
                          length >= 0, length <= 2 * 1024 * 1024, headers["transfer-encoding"] == nil else {
                        self.reply(connection, id: id, status: 400, value: ["error": "请求长度无效"]); return
                    }
                    if bytes.count >= end.upperBound + length {
                        self.handle(connection, id: id, method: String(parts[0]), path: String(parts[1]),
                                    authorization: headers["authorization"] ?? "",
                                    body: bytes.subdata(in: end.upperBound..<(end.upperBound + length)),
                                    keepAlive: headers["connection"]?.lowercased() == "keep-alive")
                        return
                    }
                } else if bytes.count > 8192 {
                    self.reply(connection, id: id, status: 400, value: ["error": "请求头过大"]); return
                }
                if complete || error != nil { self.connections.removeValue(forKey: id); connection.cancel() }
                else { self.receive(connection, id: id, buffer: bytes) }
            }
        }
    }

    private func handle(_ connection: NWConnection, id: UUID, method: String, path: String, authorization: String, body: Data, keepAlive: Bool) {
        if method == "GET", path == "/events" {
            guard active, connectionKind == "USB", authorization == "Bearer \(token)", body.isEmpty, usbControls == nil else {
                reply(connection, id: id, status: 409, value: ["error": "USB 控制连接不可用"]); return
            }
            usbControls = connection; usbControlsID = id; usbControlsBusy = true
            let header = Data("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
            connection.send(content: header, completion: .contentProcessed { [weak self, weak connection] error in
                MainActor.assumeIsolated {
                    guard let self, let connection, self.usbControls === connection else { return }
                    self.usbControlsBusy = false
                    if error != nil { connection.cancel() } else { self.publishUSBControls() }
                }
            })
            // Observe EOF even when no controls are being sent.
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in connection.cancel() }
            return
        }
        Task {
            await process(method: method, path: path, authorization: authorization, body: body) { status, value in
                reply(connection, id: id, status: status, value: value, keepAlive: keepAlive && method != "DELETE")
            }
        }
    }

    private func process(method: String, path: String, authorization: String, body: Data, response: (Int, [String: Any]) -> Void) async {
        func respond(_ status: Int = 200, _ value: [String: Any]) { response(status, value) }
        expireUSBInvitation()
        if method == "GET", path == "/status" {
            var outgoing: Any = NSNull()
            if let invitation = usbInvitation, invitation.outgoing, invitation.status == "pending" {
                outgoing = ["id": invitation.id, "expiresAt": invitation.expiresAt.timeIntervalSince1970 * 1000]
            }
            respond(200, ["protocol": screenProtocol, "deviceName": UIDevice.current.name, "active": active,
                     "usbInvitations": true, "invitationPending": awaitingUSBInvitation,
                     "outgoingInvitation": outgoing,
                     "stale": stale, "receivedFrames": receivedFrames, "keepalive": true, "jointControl": true,
                     "realtimeUSB": UIDevice.current.userInterfaceIdiom == .pad,
                     "controlPage": page, "connectionKind": connectionKind, "jointCount": workspace?.joints.count ?? 0, "viewportFrames": viewportFrames,
                     "jointValues": Dictionary(uniqueKeysWithValues: (workspace?.joints ?? []).map { ($0.name, $0.value) }),
                     "controlAck": workspace?.ack ?? 0, "pendingControls": pending.count,
                     "controlsStale": controlsStale, "viewportEnabled": workspace?.viewportControl?.enabled ?? false,
                     "viewportSupported": workspace?.viewportControl != nil,
                     "canNavigateViewport": canNavigateViewport, "viewportSequence": viewportSequence,
                     "viewportAck": workspace?.viewportControl?.ack ?? 0, "pendingViewport": pendingViewport.count,
                     "captureTaskId": workspace?.capture?.taskId ?? "", "captureParkingPointId": workspace?.capture?.parkingPointId ?? "",
                     "capturePending": awaitingCapture, "captureMessage": captureMessage, "captureNotice": captureNotice ?? "",
                     "width": left?.size.width ?? 0, "height": left?.size.height ?? 0]); return
        }
        if method == "POST", path == "/invitation" {
            guard let value = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                  value["decision"] == "reject", let invitation = usbInvitation,
                  invitation.outgoing, invitation.status == "pending", value["id"] == invitation.id else {
                respond(409, ["error": "邀请已取消或过期，请重新发起"]); return
            }
            usbInvitation?.status = "rejected"; usbInvitationMessage = "电脑已拒绝此次协作邀请。"
            respond(200, ["rejected": true]); return
        }
        if path == "/session", method == "GET" || method == "DELETE",
           let invitation = usbInvitation, !invitation.token.isEmpty, authorization == "Bearer \(invitation.token)" {
            if method == "DELETE" {
                if active { finish() }
                else if invitation.status == "pending" { cancelUSBInvitation() }
                respond(200, ["stopped": true])
            } else {
                respond(200, ["ready": active, "invitationStatus": invitation.status,
                              "expiresAt": invitation.expiresAt.timeIntervalSince1970 * 1000])
            }
            return
        }
        if method == "POST", path == "/session" {
            guard !active else { respond(409, ["error": "设备已有画面协作"]); return }
            let candidate = String(authorization.dropFirst(7))
            guard !connecting || candidate == networkToken else { respond(409, ["error": "设备正在进行 Wi-Fi 配对"]); return }
            guard authorization.hasPrefix("Bearer "), candidate.count == 64,
                  candidate.allSatisfy({ "0123456789abcdef".contains($0) }),
                  let value = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                  value["protocol"] == screenProtocol else { respond(400, ["error": "协作协议无效"]); return }
            // Scanning a code / entering a Wi-Fi code is already an explicit join action.
            if connecting, candidate == networkToken {
                guard !awaitingUSBInvitation else { respond(409, ["error": "请先结束有线邀请"]); return }
                beginSession(token: candidate); respond(200, ["ready": true]); return
            }
            guard !connecting else { respond(409, ["error": "正在连接 Wi-Fi，请先完成或取消当前连接"]); return }
            guard let sessionID = value["sessionId"], UUID(uuidString: sessionID) != nil else {
                respond(409, ["error": "请更新并刷新电脑工作台，以使用需要确认的有线协作邀请"]); return
            }
            if let invitationID = value["invitationId"] {
                guard let invitation = usbInvitation, invitation.outgoing, invitation.status == "pending",
                      invitation.id == invitationID else { respond(409, ["error": "邀请已取消或过期"]); return }
                usbInvitation?.token = candidate; usbInvitation?.status = "accepted"
                usbInvitationMessage = "电脑已接受邀请，正在准备画面…"
                beginSession(token: candidate); respond(200, ["ready": true]); return
            }
            if let invitation = usbInvitation, invitation.id == sessionID, invitation.token == candidate {
                respond(200, ["ready": false, "invitationStatus": invitation.status,
                              "expiresAt": invitation.expiresAt.timeIntervalSince1970 * 1000]); return
            }
            guard !awaitingUSBInvitation else { respond(409, ["error": "已有协作邀请，请先处理当前邀请"]); return }
            usbInvitation = ScreenUSBInvitation(id: sessionID, outgoing: false,
                computerName: String((value["computerName"] ?? "电脑工作台").prefix(80)),
                expiresAt: Date().addingTimeInterval(60), token: candidate)
            usbInvitationMessage = "电脑正在邀请你加入画面协作。"
            respond(200, ["ready": false, "invitationStatus": "pending",
                          "expiresAt": usbInvitation!.expiresAt.timeIntervalSince1970 * 1000]); return
        }
        guard active, authorization == "Bearer \(token)" else { respond(410, ["error": "设备已结束画面协作"]); return }
        if method == "DELETE", path == "/session" { finish(); respond(200, ["stopped": true]); return }
        if method == "PUT", path == "/heartbeat", body.isEmpty {
            lastContact = Date(); respond(200, collaborationStatus()); return
        }
        if method == "PUT", path == "/workspace" {
            guard body.count >= 10 else { respond(400, ["error": "关节数据不完整"]); return }
            let stateSize = body[0..<4].reduce(0) { ($0 << 8) | Int($1) }
            let imageSize = body[4..<8].reduce(0) { ($0 << 8) | Int($1) }
            guard stateSize <= 65536, 8 + stateSize + imageSize == body.count,
                  let state = try? JSONDecoder().decode(ScreenJointState.self, from: body.subdata(in: 8..<(8 + stateSize))), state.valid else {
                respond(400, ["error": "关节状态无效"]); return
            }
            var image: UIImage?, imageData: Data?
            if imageSize > 0 {
                let data = body.subdata(in: (8 + stateSize)..<body.count)
                guard let decoded = data == viewportData ? viewport : await decodeImage(data) else {
                    respond(400, ["error": "三维画面无效"]); return
                }
                image = decoded; imageData = data
            }
            guard active, authorization == "Bearer \(token)" else { respond(410, ["error": "设备已结束画面协作"]); return }
            if !pending.isEmpty {
                if workspace?.robotId != state.robotId || !state.editable { pending = [:] }
                else if pending.values.contains(where: { $0.sequence <= state.ack }) { pending = pending.filter { $0.value.sequence > state.ack } }
            }
            if workspace?.robotId != state.robotId || state.viewportControl?.enabled != true { pendingViewport = [] }
            else { pendingViewport.removeAll { $0.sequence <= (state.viewportControl?.ack ?? 0) } }
            if workspace != state { workspace = state }
            if let capture = pendingCapture, let result = state.captureResult, result.id == capture.id {
                captureAccepted = true; captureMessage = result.message
                if result.status != "recording" {
                    pendingCapture = nil
                    if result.status == "error" { captureNotice = result.message }
                }
            }
            lastWorkspace = Date(); lastContact = lastWorkspace
            if controlsStale { controlsStale = false }
            if let image {
                if imageData != viewportData { viewport = image; viewportData = imageData }
                viewportFrames += 1
                if page == "joints", stale { stale = false }
            }
            if !pendingViewport.isEmpty || !pending.isEmpty { publishUSBControls() }
            respond(200, collaborationStatus()); return
        }
        guard method == "PUT", path == "/frame", body.count >= 16 else { respond(400, ["error": "画面请求无效"]); return }
        func size(at offset: Int) -> Int { body[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) } }
        let leftSize = size(at: 0), rightSize = size(at: 4)
        guard leftSize >= 4, rightSize >= 4, leftSize + rightSize + 8 == body.count else {
            respond(400, ["error": "双臂画面不完整"]); return
        }
        let nextLeft = body.subdata(in: 8..<(8 + leftSize)), nextRight = body.subdata(in: (8 + leftSize)..<body.count)
        guard let leftImage = nextLeft == leftData ? left : await decodeImage(nextLeft),
              let rightImage = nextRight == rightData ? right : await decodeImage(nextRight) else {
            respond(400, ["error": "双臂画面不完整"]); return
        }
        guard active, authorization == "Bearer \(token)" else { respond(410, ["error": "设备已结束画面协作"]); return }
        if nextLeft != leftData { left = leftImage; leftData = nextLeft }
        if nextRight != rightData { right = rightImage; rightData = nextRight }
        lastFrame = Date(); lastContact = lastFrame; if stale { stale = false }; receivedFrames += 1
        var result = collaborationStatus(); result["received"] = true; result["receivedFrames"] = receivedFrames
        respond(200, result)
    }

    private func decodeImage(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) {
            autoreleasepool {
                guard data.starts(with: [0xff, 0xd8]), let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, width <= 1920, height <= 1200,
                      let image = UIImage(data: data) else { return nil as UIImage? }
                return image.preparingForDisplay()
            }
        }.value
    }

    private func reply(_ connection: NWConnection, id: UUID, status: Int, value: [String: Any], keepAlive: Bool = false) {
        let body = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
        var bytes = Data("HTTP/1.1 \(status) Response\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: \(keepAlive ? "keep-alive" : "close")\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        bytes.append(body)
        connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
            MainActor.assumeIsolated {
                guard let self else { connection.cancel(); return }
                if keepAlive, error == nil, self.connections[id] != nil {
                    self.connectionActivity[id] = Date()
                    self.receive(connection, id: id, buffer: Data())
                } else { connection.cancel() }
            }
        })
    }
}

struct ScreenCollaborationHost: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var screen = ScreenCollaboration()
    var body: some View {
        ContentView()
            .environmentObject(screen)
            .environment(\.screenCollaborationActive, screen.active)
            .fullScreenCover(isPresented: Binding(get: { screen.active }, set: { if !$0 { screen.finish() } })) {
                ScreenCollaborationView(screen: screen).interactiveDismissDisabled()
            }
            .onAppear { if scenePhase == .active { screen.start() } }
            .onChange(of: scenePhase) { _, phase in if phase == .active { screen.start() } else { screen.stop() } }
            .alert("接受画面协作邀请？", isPresented: Binding(
                get: { screen.incomingUSBInvitation != nil },
                set: { _ in }
            ), presenting: screen.incomingUSBInvitation) { invitation in
                Button("接受邀请") { screen.respondToUSBInvitation(id: invitation.id, accept: true) }
                    .accessibilityIdentifier("accept-screen-invitation")
                Button("拒绝", role: .cancel) { screen.respondToUSBInvitation(id: invitation.id, accept: false) }
                    .accessibilityIdentifier("reject-screen-invitation")
            } message: { invitation in
                Text("「\(invitation.computerName)」通过数据线邀请你协作。接受后可查看相机画面与 3D 视图、调整虚拟机器人关节，并将记录的姿态保存到电脑当前工程。")
            }
    }
}

private struct ScreenCollaborationView: View {
    @ObservedObject var screen: ScreenCollaboration
    @State private var selection = "both"
    var body: some View {
        GeometryReader { viewport in
            let landscape = viewport.size.width > viewport.size.height
            let padding: CGFloat = TeachingDevice.isPhone ? 16 : 24
            // The system's bottom safe area is part of the outer margin.
            let bottomPadding = max(0, padding - viewport.safeAreaInsets.bottom)
            VStack(spacing: 16) {
                header(width: viewport.size.width - padding * 2)
                if screen.page == "joints" {
                    ScreenJointWorkspace(screen: screen, landscape: landscape, height: viewport.size.height)
                } else {
                HStack(spacing: 16) {
                    Picker("相机画面", selection: $selection) {
                        Text("双臂").tag("both"); Text("左臂").tag("left"); Text("右臂").tag("right")
                    }.pickerStyle(.segmented).accessibilityIdentifier("screen-collaboration-selection")
                        .frame(maxWidth: screen.captureMessage.isEmpty ? .infinity : 320)
                    if !screen.captureMessage.isEmpty { ScreenCaptureStatus(screen: screen) }
                }
                let layout = landscape ? AnyLayout(HStackLayout(spacing: 16)) : AnyLayout(VStackLayout(spacing: 16))
                layout {
                    if selection != "right" { camera(screen.left, side: "left", title: "左臂", color: screenAccent) }
                    if selection != "left" { camera(screen.right, side: "right", title: "右臂", color: Color(red: 1, green: 0.74, blue: 0.38)) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Text(selection == "both" ? "轻点画面，放大查看单臂" : "轻点画面，返回双臂视图")
                    .font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.horizontal, padding).padding(.top, padding).padding(.bottom, bottomPadding)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        }.accessibilityElement(children: .contain).accessibilityIdentifier("screen-collaboration-view")
            .alert("无法记录姿态", isPresented: Binding(get: { screen.captureNotice != nil }, set: { if !$0 { screen.captureNotice = nil } })) {
                Button("知道了", role: .cancel) { screen.captureNotice = nil }
            } message: { Text(screen.captureNotice ?? "") }
    }
    @ViewBuilder private func header(width: CGFloat) -> some View {
        if width >= 680 {
            let pickerWidth = min(280, width - 480)
            let sideWidth = (width - pickerWidth - 32) / 2
            HStack(spacing: 16) {
                connectionTitle.frame(width: sideWidth, alignment: .leading)
                pagePicker(width: pickerWidth)
                ScreenPoseCaptureButton(screen: screen).frame(width: sideWidth, alignment: .trailing)
            }
        } else {
            // Keep all controls reachable in a narrow split-screen or phone window.
            VStack(spacing: 12) {
                HStack(spacing: 12) {
                    connectionTitle
                    Spacer(minLength: 8)
                    ScreenPoseCaptureButton(screen: screen)
                }
                pagePicker(width: min(280, width))
            }
        }
    }
    private var connectionTitle: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                HStack(spacing: 8) {
                    Image(systemName: screen.connectionKind == "Wi-Fi" ? "wifi" : "cable.connector").foregroundStyle(screenAccent)
                    Text("画面协作").font(.headline).accessibilityIdentifier("screen-collaboration-title")
                }
                stopButton
            }
            Text("\(screen.connectionKind) 已连接 · \(screen.page == "joints" ? "关节与姿态同步" : screen.stale ? "等待画面更新" : "末端相机仿真画面")")
                .font(.caption).foregroundStyle(screen.stale ? .orange : screenAccent)
        }.lineLimit(1)
    }
    private var stopButton: some View {
        Button("结束协作", systemImage: "xmark", action: screen.finish)
            .font(.subheadline).buttonStyle(.bordered).controlSize(.small)
            .accessibilityIdentifier("screen-collaboration-stop")
    }
    private func pagePicker(width: CGFloat) -> some View {
        ScreenCollaborationPagePicker(selection: $screen.page).frame(width: width, height: 44)
    }
    private func camera(_ image: UIImage?, side: String, title: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle().fill(screen.stale ? .orange : color).frame(width: 7, height: 7)
                Text(title).font(.headline)
                Spacer()
                Text("ZIVID 2 M70").font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            ZStack {
                Color.black.opacity(0.35)
                if let image { Image(uiImage: image).resizable().scaledToFit() }
                if image == nil {
                    VStack(spacing: 10) {
                        Image(systemName: "cable.connector").font(.title2)
                        Text("正在连接相机画面").font(.callout)
                    }.foregroundStyle(.secondary)
                }
            }.clipShape(RoundedRectangle(cornerRadius: 10)).frame(maxWidth: .infinity, maxHeight: .infinity)
            if screen.stale && image != nil {
                Text("显示最近画面 · 连接保持中，更新后自动继续").font(.caption).foregroundStyle(.orange)
            }
        }.padding(16).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(color.opacity(0.25)))
            .contentShape(Rectangle())
            .onTapGesture { selection = selection == "both" ? side : "both" }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(title)末端相机画面").accessibilityIdentifier("screen-camera-\(side)")
            .accessibilityAddTraits(.isButton)
    }
}

// Give the native segments a full 44-point touch surface without scaling their text.
private struct ScreenCollaborationPagePicker: UIViewRepresentable {
    @Binding var selection: String
    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }
    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ["相机画面", "关节控制"])
        control.accessibilityIdentifier = "screen-page-tabs"
        control.accessibilityLabel = "协作子页"
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return control
    }
    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.selection = $selection
        control.selectedSegmentIndex = selection == "joints" ? 1 : 0
        control.setTitleTextAttributes([.font: UIFont.preferredFont(forTextStyle: .subheadline)], for: .normal)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UISegmentedControl, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 280, height: 44)
    }
    final class Coordinator: NSObject {
        var selection: Binding<String>
        init(selection: Binding<String>) { self.selection = selection }
        @objc func changed(_ control: UISegmentedControl) {
            guard control.selectedSegmentIndex == 0 || control.selectedSegmentIndex == 1 else { return }
            selection.wrappedValue = control.selectedSegmentIndex == 1 ? "joints" : "cameras"
        }
    }
}

private struct ScreenPoseCaptureButton: View {
    @ObservedObject var screen: ScreenCollaboration
    private var destination: String {
        guard let capture = screen.workspace?.capture, !capture.taskName.isEmpty else { return "保存到网页端当前任务与停车点" }
        return "\(capture.taskName) / \(capture.parkingPointName.isEmpty ? "未选择停车点" : capture.parkingPointName)"
    }
    var body: some View {
        Button(action: screen.recordPose) {
            HStack(spacing: 8) {
                if screen.awaitingCapture { ProgressView().tint(.black) }
                else { Image(systemName: "square.and.arrow.down") }
                Text(screen.awaitingCapture ? "正在记录…" : "记录姿态").fontWeight(.semibold)
            }.frame(minHeight: 24)
        }.buttonStyle(.borderedProminent).tint(screenAccent).foregroundStyle(.black).controlSize(.large)
            .fixedSize(horizontal: true, vertical: true)
            .disabled(screen.awaitingCapture || screen.awaitingControl)
            .accessibilityIdentifier("screen-record-pose")
            .accessibilityValue(destination)
    }
}

private struct ScreenCaptureStatus: View {
    @ObservedObject var screen: ScreenCollaboration
    var body: some View {
        Text(screen.captureMessage).font(.callout).foregroundStyle(screenAccent).lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("screen-capture-status")
    }
}

private struct ScreenJointWorkspace: View {
    @ObservedObject var screen: ScreenCollaboration
    let landscape: Bool
    let height: CGFloat
    var body: some View {
        let layout = landscape ? AnyLayout(HStackLayout(alignment: .top, spacing: 18)) : AnyLayout(VStackLayout(spacing: 14))
        layout {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Label("3D 姿态", systemImage: "cube.transparent").font(.headline).fixedSize()
                        .accessibilityIdentifier("screen-viewport-title")
                    if !screen.captureMessage.isEmpty || screen.viewportUnavailableReason != nil {
                        VStack(alignment: .leading, spacing: 4) {
                            if !screen.captureMessage.isEmpty { ScreenCaptureStatus(screen: screen) }
                            if let reason = screen.viewportUnavailableReason {
                                Text(reason).font(.caption).foregroundStyle(.orange)
                                    .accessibilityIdentifier("screen-viewport-status")
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Spacer()
                        Text("与电脑同步").font(.caption).foregroundStyle(screenAccent)
                    }
                }
                ZStack {
                    Color.black.opacity(0.35)
                    if let image = screen.viewport {
                        Image(uiImage: image).resizable().scaledToFit()
                            .accessibilityLabel("与电脑同步的机器人三维视图")
                            .accessibilityIdentifier("screen-robot-viewport")
                    } else {
                        ProgressView("正在同步三维画面…").tint(screenAccent)
                    }
                    ScreenViewportGestures(screen: screen)
                }.clipShape(RoundedRectangle(cornerRadius: 12)).frame(maxWidth: .infinity, maxHeight: .infinity)
            }.padding(16)
                .frame(maxWidth: .infinity, maxHeight: landscape ? .infinity : height * 0.34)
                .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
                .accessibilityElement(children: .contain).accessibilityIdentifier("screen-viewport-panel")
            ScreenJointEditor(screen: screen)
                .frame(width: landscape ? (TeachingDevice.isPhone ? 320 : 380) : nil)
                .frame(maxWidth: landscape ? nil : .infinity, maxHeight: .infinity)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ScreenViewportGestures: UIViewRepresentable {
    @ObservedObject var screen: ScreenCollaboration
    func makeUIView(context: Context) -> ScreenViewportGestureView { ScreenViewportGestureView() }
    func updateUIView(_ view: ScreenViewportGestureView, context: Context) {
        view.sourceAspect = screen.workspace?.viewportControl?.aspect ?? 1.6
        view.imageAspect = Double((screen.viewport?.size.width ?? 960) / (screen.viewport?.size.height ?? 600))
        view.onMotion = { [weak screen] kind, dx, dy, zoom in screen?.navigateViewport(kind: kind, dx: dx, dy: dy, zoom: zoom) }
        view.setGesturesEnabled(screen.canNavigateViewport)
    }
}

// UIKit distinguishes finger counts and permits two-finger pan and pinch
// together without allowing either gesture to rotate the view.
private final class ScreenViewportGestureView: UIView, UIGestureRecognizerDelegate {
    var sourceAspect = 1.6
    var imageAspect = 1.6
    var onMotion: ((String, Double, Double, Double) -> Void)?
    private var drag: UIPanGestureRecognizer!
    private var pinch: UIPinchGestureRecognizer!
    private var previousTouches = 0
    private var previousSize = CGSize.zero
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear; isMultipleTouchEnabled = true
        isAccessibilityElement = true; accessibilityIdentifier = "screen-viewport-gestures"
        accessibilityLabel = "三维视角控制"; accessibilityHint = "单指旋转，双指开合缩放，双指拖动平移"
        drag = UIPanGestureRecognizer(target: self, action: #selector(dragged(_:)))
        drag.minimumNumberOfTouches = 1; drag.maximumNumberOfTouches = 2; drag.delegate = self
        pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:))); pinch.delegate = self
        addGestureRecognizer(drag); addGestureRecognizer(pinch)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func setGesturesEnabled(_ enabled: Bool) {
        if drag.isEnabled != enabled { drag.isEnabled = enabled; pinch.isEnabled = enabled; previousTouches = 0 }
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.size != previousSize {
            previousSize = bounds.size; previousTouches = 0
            let enabled = drag.isEnabled
            drag.isEnabled = false; pinch.isEnabled = false
            drag.isEnabled = enabled; pinch.isEnabled = enabled
        }
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        (gestureRecognizer === drag && otherGestureRecognizer === pinch) || (gestureRecognizer === pinch && otherGestureRecognizer === drag)
    }
    private var contentHeight: Double {
        let imageHeight = min(Double(bounds.height), Double(bounds.width) / imageAspect)
        return max(1, min(imageHeight, imageHeight * imageAspect / sourceAspect))
    }
    @objc private func dragged(_ gesture: UIPanGestureRecognizer) {
        let touches = gesture.numberOfTouches, delta = gesture.translation(in: self)
        gesture.setTranslation(.zero, in: self)
        defer { previousTouches = touches }
        guard gesture.state == .changed, touches == previousTouches, touches == 1 || touches == 2 else { return }
        onMotion?(touches == 1 ? "rotate" : "pan", Double(delta.x) / contentHeight, Double(delta.y) / contentHeight, 0)
    }
    @objc private func pinched(_ gesture: UIPinchGestureRecognizer) {
        let scale = Double(gesture.scale); gesture.scale = 1
        guard gesture.state == .changed, gesture.numberOfTouches == 2, scale.isFinite, scale > 0 else { return }
        onMotion?("zoom", 0, 0, log(scale))
    }
}

private struct ScreenJointEditor: View {
    @ObservedObject var screen: ScreenCollaboration
    @State private var selectedGroup = "全部"
    private let groups = ["底盘轮组", "躯干与升降", "头部", "左机械臂", "右机械臂", "其他关节"]
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(screen.workspace?.robotName ?? "机器人").font(.headline).lineLimit(1)
                Spacer()
                Text(screen.awaitingControl ? "同步中…" : "双向同步").font(.caption)
                    .foregroundStyle(screen.awaitingControl ? .orange : screenAccent)
            }
            if screen.controlsStale {
                Label("等待电脑更新，恢复后可继续调节。", systemImage: "pause.circle")
                    .font(.caption).foregroundStyle(.orange)
            } else if let state = screen.workspace, !state.editable {
                Text(state.reason).font(.caption).foregroundStyle(.orange)
            }
            if !screen.controlMessage.isEmpty { Text(screen.controlMessage).font(.caption).foregroundStyle(.orange) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    groupButton("全部", title: "全部")
                    groupButton("左机械臂", title: "左臂")
                    groupButton("右机械臂", title: "右臂")
                    groupButton("躯干与升降", title: "躯干")
                    groupButton("头部", title: "头部")
                    groupButton("底盘轮组", title: "底盘")
                    groupButton("其他关节", title: "其他")
                }
            }.fixedSize(horizontal: false, vertical: true)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(groups.filter { selectedGroup == "全部" || selectedGroup == $0 }, id: \.self) { group in
                        let joints = screen.workspace?.joints.filter { $0.group == group } ?? []
                        if !joints.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                HStack {
                                    Text(group).font(.subheadline.bold())
                                    Spacer()
                                    Text("\(joints.count)").font(.caption.monospaced()).foregroundStyle(.secondary)
                                }.foregroundStyle(screenAccent)
                                ForEach(joints) { joint in jointRow(joint) }
                            }
                        }
                    }
                }.padding(.vertical, 4)
            }.accessibilityIdentifier("screen-joint-list")
        }.padding(16).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16))
    }

    @ViewBuilder private func groupButton(_ group: String, title: String) -> some View {
        if group == "全部" || screen.workspace?.joints.contains(where: { $0.group == group }) == true {
            Button { selectedGroup = group } label: {
                Text(title).font(.caption.bold()).padding(.horizontal, 12).padding(.vertical, 9)
                    .foregroundStyle(selectedGroup == group ? Color.black : screenAccent)
                    .background(selectedGroup == group ? screenAccent : screenAccent.opacity(0.1), in: Capsule())
            }.buttonStyle(.plain).accessibilityLabel(group)
                .accessibilityIdentifier("screen-joint-group-\(group)")
                .accessibilityAddTraits(selectedGroup == group ? .isSelected : [])
        }
    }

    private func jointRow(_ joint: ScreenJoint) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(joint.name).font(.subheadline.monospaced()).lineLimit(1)
                Spacer()
                Text("\(joint.formatted(screen.jointValue(joint))) \(joint.unit)")
                    .font(.subheadline.monospaced()).monospacedDigit().foregroundStyle(screenAccent)
                    .accessibilityIdentifier("screen-joint-value-\(joint.name)")
            }
            Slider(value: Binding(get: { min(joint.upper, max(joint.lower, screen.jointValue(joint))) },
                                  set: { screen.changeJoint(joint, value: $0) }),
                   in: joint.lower...max(joint.upper, joint.lower + joint.step), step: joint.step)
                .tint(screenAccent).disabled(!screen.canControl || joint.lower == joint.upper)
                .accessibilityLabel("\(joint.name) 关节滑块")
                .accessibilityValue("\(joint.formatted(screen.jointValue(joint))) \(joint.unit)")
                .accessibilityIdentifier("screen-joint-\(joint.name)")
            HStack {
                Text("\(joint.formatted(joint.lower)) \(joint.unit)")
                Spacer()
                Text("\(joint.formatted(joint.upper)) \(joint.unit)")
            }.font(.caption2.monospaced()).foregroundStyle(.secondary)
        }.padding(12).background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
    }
}
