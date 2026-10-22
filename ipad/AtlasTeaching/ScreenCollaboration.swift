import SwiftUI
import Network
import UIKit
import ImageIO

private let screenProtocol = "atlas-ipad-screen/1"
private let screenAccent = Color(red: 0.35, green: 0.86, blue: 0.91)

private struct ScreenCollaborationActiveKey: EnvironmentKey {
    static let defaultValue = false
}
extension EnvironmentValues {
    var screenCollaborationActive: Bool {
        get { self[ScreenCollaborationActiveKey.self] }
        set { self[ScreenCollaborationActiveKey.self] = newValue }
    }
}

/// The listener is loopback-only: the paired computer reaches it through USB
/// multiplexing. It is never advertised on Bonjour or exposed on Wi-Fi.
@MainActor
final class ScreenCollaboration: ObservableObject {
    @Published private(set) var active = false
    @Published private(set) var stale = true
    @Published private(set) var left: UIImage?
    @Published private(set) var right: UIImage?
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var token = ""
    private var lastFrame = Date.distantPast
    private var timer: Timer?
    private var receivedFrames = 0
    private var previousIdleTimerDisabled = false

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
                guard let self, self.active else { return }
                self.stale = Date().timeIntervalSince(self.lastFrame) > 2.5
                if Date().timeIntervalSince(self.lastFrame) > 10 { self.finish() }
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
        if active { UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled }
        active = false; stale = true; token = ""; left = nil; right = nil
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 4 else { connection.cancel(); return }
        let id = UUID(); connections[id] = connection
        connection.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak connection] in
            guard let self, let connection, self.connections[id] === connection else { return }
            self.connections.removeValue(forKey: id); connection.cancel()
        }
        receive(connection, id: id, buffer: Data())
    }

    private func receive(_ connection: NWConnection, id: UUID, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, complete, error in
            MainActor.assumeIsolated {
                guard let self, self.connections[id] != nil else { return }
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
                                    body: bytes.subdata(in: end.upperBound..<(end.upperBound + length)))
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

    private func handle(_ connection: NWConnection, id: UUID, method: String, path: String, authorization: String, body: Data) {
        func respond(_ status: Int = 200, _ value: [String: Any]) { reply(connection, id: id, status: status, value: value) }
        if method == "GET", path == "/status" {
            respond(200, ["protocol": screenProtocol, "deviceName": UIDevice.current.name, "active": active,
                     "stale": stale, "receivedFrames": receivedFrames,
                     "width": left?.size.width ?? 0, "height": left?.size.height ?? 0]); return
        }
        if method == "POST", path == "/session" {
            guard !active else { respond(409, ["error": "设备已有画面协作"]); return }
            let candidate = String(authorization.dropFirst(7))
            guard authorization.hasPrefix("Bearer "), candidate.count == 64,
                  candidate.allSatisfy({ "0123456789abcdef".contains($0) }),
                  let value = try? JSONSerialization.jsonObject(with: body) as? [String: String],
                  value["protocol"] == screenProtocol else { respond(400, ["error": "协作协议无效"]); return }
            token = candidate; receivedFrames = 0; lastFrame = Date(); stale = true
            previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
            UIApplication.shared.isIdleTimerDisabled = true
            active = true; respond(200, ["ready": true]); return
        }
        guard active, authorization == "Bearer \(token)" else { respond(410, ["error": "设备已结束画面协作"]); return }
        if method == "DELETE", path == "/session" { finish(); respond(200, ["stopped": true]); return }
        guard method == "PUT", path == "/frame", body.count >= 16 else { respond(400, ["error": "画面请求无效"]); return }
        func size(at offset: Int) -> Int { body[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) } }
        let leftSize = size(at: 0), rightSize = size(at: 4)
        guard leftSize >= 4, rightSize >= 4, leftSize + rightSize + 8 == body.count,
              let leftImage = decodeImage(body.subdata(in: 8..<(8 + leftSize))),
              let rightImage = decodeImage(body.subdata(in: (8 + leftSize)..<body.count)) else {
            respond(400, ["error": "双臂画面不完整"]); return
        }
        left = leftImage; right = rightImage; lastFrame = Date(); stale = false; receivedFrames += 1
        respond(200, ["received": true, "receivedFrames": receivedFrames])
    }

    private func decodeImage(_ data: Data) -> UIImage? {
        guard data.starts(with: [0xff, 0xd8]), let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 1920, height <= 1200 else { return nil }
        return UIImage(data: data)
    }

    private func reply(_ connection: NWConnection, id: UUID, status: Int, value: [String: Any]) {
        let body = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
        var bytes = Data("HTTP/1.1 \(status) Response\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.count)\r\n\r\n".utf8)
        bytes.append(body)
        connection.send(content: bytes, completion: .contentProcessed { [weak self] _ in
            MainActor.assumeIsolated { self?.connections.removeValue(forKey: id); connection.cancel() }
        })
    }
}

struct ScreenCollaborationHost: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var screen = ScreenCollaboration()
    var body: some View {
        ContentView()
            .environment(\.screenCollaborationActive, screen.active)
            .fullScreenCover(isPresented: Binding(get: { screen.active }, set: { if !$0 { screen.finish() } })) {
                ScreenCollaborationView(screen: screen).interactiveDismissDisabled()
            }
            .onAppear { if scenePhase == .active { screen.start() } }
            .onChange(of: scenePhase) { _, phase in if phase == .active { screen.start() } else { screen.stop() } }
    }
}

private struct ScreenCollaborationView: View {
    @ObservedObject var screen: ScreenCollaboration
    @State private var selection = "both"
    var body: some View {
        GeometryReader { viewport in
            let landscape = viewport.size.width > viewport.size.height
            VStack(spacing: 16) {
                HStack(spacing: 12) {
                    Image(systemName: "cable.connector").foregroundStyle(screenAccent)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("画面协作").font(.headline)
                        Text(screen.stale ? "等待电脑画面…" : "USB 已连接 · 末端相机仿真画面")
                            .font(.caption).foregroundStyle(screen.stale ? .orange : screenAccent)
                    }
                    Spacer()
                    Button("结束协作", systemImage: "xmark", action: screen.finish)
                        .buttonStyle(.bordered).accessibilityIdentifier("screen-collaboration-stop")
                }
                Picker("相机画面", selection: $selection) {
                    Text("双臂").tag("both"); Text("左臂").tag("left"); Text("右臂").tag("right")
                }.pickerStyle(.segmented).accessibilityIdentifier("screen-collaboration-selection")
                let layout = landscape ? AnyLayout(HStackLayout(spacing: 16)) : AnyLayout(VStackLayout(spacing: 16))
                layout {
                    if selection != "right" { camera(screen.left, side: "left", title: "左臂", color: screenAccent) }
                    if selection != "left" { camera(screen.right, side: "right", title: "右臂", color: Color(red: 1, green: 0.74, blue: 0.38)) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Text(selection == "both" ? "轻点画面，放大查看单臂" : "轻点画面，返回双臂视图")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(TeachingDevice.isPhone ? 16 : 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        }.accessibilityElement(children: .contain).accessibilityIdentifier("screen-collaboration-view")
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
                if let image { Image(uiImage: image).resizable().scaledToFit().opacity(screen.stale ? 0.25 : 1) }
                if screen.stale {
                    VStack(spacing: 10) {
                        Image(systemName: "cable.connector.slash").font(.title2)
                        Text(image == nil ? "正在连接相机画面" : "画面已暂停，请检查电脑和数据线").font(.callout)
                    }.foregroundStyle(.secondary)
                }
            }.clipShape(RoundedRectangle(cornerRadius: 10)).frame(maxWidth: .infinity, maxHeight: .infinity)
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
