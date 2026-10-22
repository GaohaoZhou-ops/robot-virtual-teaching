import Foundation
import Combine
import CryptoKit

private let usbProtocol = "atlas-ipad-usb/1"

struct USBConnection: Codable {
    let `protocol`: String
    let serverId: String
    let serverName: String
    let transport: String
    let updatedAt: Double
    let expiresAt: Double
    let nonce: String

    func isCurrent(at date: Date) -> Bool {
        let now = date.timeIntervalSince1970 * 1000
        return self.protocol == usbProtocol && transport == "usb" && UUID(uuidString: serverId) != nil
            && UUID(uuidString: nonce) != nil && !serverName.isEmpty && serverName.count <= 120
            && updatedAt.isFinite && expiresAt.isFinite && updatedAt <= now + 5000
            && updatedAt >= now - 20_000 && expiresAt > now && expiresAt - updatedAt <= 20_000
    }
}

struct USBModelTransfer: Codable, Identifiable {
    let `protocol`: String
    let id: String
    let serverName: String
    let sourceSessionId: String
    let manifest: ModelManifest
    var poseSeed: TeachingPoseSeed? = nil

    func validate() throws {
        guard self.protocol == usbProtocol, UUID(uuidString: id) != nil, UUID(uuidString: sourceSessionId) != nil,
              manifest.protocol == teachingProtocol, manifest.coordinateFrame == "virtual_origin",
              manifest.distanceUnit == "meter", manifest.verticalAxis == "Z",
              (48...maximumModelBytes).contains(manifest.byteLength),
              !manifest.name.isEmpty, manifest.name.count <= 240,
              manifest.modelHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw TeachingError("数据线文件格式不支持，请在电脑重新发送物体")
        }
        _ = try poseSeed?.validatedSamples()
    }
}

struct USBInboxSnapshot {
    var connection: USBConnection?
    var transfers: [USBModelTransfer] = []
    var message = ""
}

actor USBModelInbox {
    let directory: URL
    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Atlas USB", isDirectory: true)
    }
    private func regularFile(_ url: URL, maximum: Int) throws -> Int {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size > 0, size <= maximum else {
            throw TeachingError("数据线文件不完整，请在电脑重新发送")
        }
        return size
    }
    private func decode<T: Decodable>(_ type: T.Type, at url: URL, maximum: Int = 65536) throws -> T {
        _ = try regularFile(url, maximum: maximum)
        return try JSONDecoder().decode(type, from: Data(contentsOf: url))
    }
    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw TeachingError("数据线文件标识无效") }
        let folder = directory.appendingPathComponent("Inbox", isDirectory: true).appendingPathComponent(id, isDirectory: true)
        for url in [directory, folder.deletingLastPathComponent(), folder] {
            let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw TeachingError("数据线文件目录无效") }
        }
        return folder
    }
    private func transfer(_ id: String) throws -> USBModelTransfer {
        let folder = try folder(id)
        let record = try decode(USBModelTransfer.self, at: folder.appendingPathComponent("ready.json"), maximum: 32 * 1024 * 1024)
        try record.validate()
        guard record.id == id,
              try regularFile(folder.appendingPathComponent("model.atls"), maximum: maximumModelBytes) == record.manifest.byteLength else {
            throw TeachingError("数据线文件尚未传输完整，请在电脑重试")
        }
        return record
    }
    func snapshot(now: Date = Date()) throws -> USBInboxSnapshot {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup != true {
            var root = directory, values = URLResourceValues()
            values.isExcludedFromBackup = true; try root.setResourceValues(values)
        }
        var snapshot = USBInboxSnapshot()
        if let connection = try? decode(USBConnection.self, at: directory.appendingPathComponent("connection.json")),
           connection.isCurrent(at: now) { snapshot.connection = connection }
        let inbox = directory.appendingPathComponent("Inbox", isDirectory: true)
        guard FileManager.default.fileExists(atPath: inbox.path) else { return snapshot }
        let entries = try FileManager.default.contentsOfDirectory(at: inbox, includingPropertiesForKeys: nil)
        for entry in entries.filter({ UUID(uuidString: $0.lastPathComponent) != nil }).prefix(64) {
            // The Mac writes ready.json only after the complete model is copied.
            guard FileManager.default.fileExists(atPath: entry.appendingPathComponent("ready.json").path) else { continue }
            do { snapshot.transfers.append(try transfer(entry.lastPathComponent)) }
            catch { snapshot.message = "有文件尚未准备好，请在电脑重新发送。已有项目不受影响。" }
        }
        snapshot.transfers.sort { $0.manifest.name.localizedStandardCompare($1.manifest.name) == .orderedAscending }
        return snapshot
    }
    func model(_ selected: USBModelTransfer) throws -> Data {
        let current = try transfer(selected.id)
        guard current.manifest.modelHash == selected.manifest.modelHash,
              current.manifest.byteLength == selected.manifest.byteLength else {
            throw TeachingError("待接收文件已变化，请刷新后重新选择")
        }
        // Copy into owned memory: a host retry may truncate the inbox file while
        // it is being read; mapping that mutable file could fault after truncation.
        let data = try Data(contentsOf: folder(selected.id).appendingPathComponent("model.atls"))
        guard data.count == selected.manifest.byteLength,
              SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == selected.manifest.modelHash else {
            throw TeachingError("数据线模型校验失败，请在电脑重新发送；原有示教数据保留")
        }
        return data
    }
    func removeReceived(_ selected: USBModelTransfer) throws {
        let current = try transfer(selected.id)
        guard current.manifest.modelHash == selected.manifest.modelHash else { return }
        try FileManager.default.removeItem(at: folder(selected.id))
    }
}

@MainActor
final class USBFileReceiver: ObservableObject {
    @Published private(set) var connection: USBConnection?
    @Published private(set) var transfers: [USBModelTransfer] = []
    @Published private(set) var message = ""
    let inbox = USBModelInbox()
    private var task: Task<Void, Never>?
    func start() {
        guard task == nil else { return }
        task = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                do { try await Task.sleep(for: .seconds(2)) } catch { break }
            }
        }
    }
    func stop() { task?.cancel(); task = nil; connection = nil }
    func refresh() async {
        do {
            let snapshot = try await inbox.snapshot()
            guard !Task.isCancelled else { return }
            connection = snapshot.connection; transfers = snapshot.transfers; message = snapshot.message
        } catch {
            guard !Task.isCancelled else { return }
            connection = nil; message = "暂时无法读取数据线文件，请解锁 iPad 后重试。"
        }
    }
}
