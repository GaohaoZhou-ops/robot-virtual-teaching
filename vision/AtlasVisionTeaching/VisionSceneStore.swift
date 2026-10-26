import Foundation

actor VisionSceneStore {
    static let shared = VisionSceneStore()
    private let directory: URL?
    init(directory: URL? = nil) { self.directory = directory }
    private func root() throws -> URL {
        var url = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AtlasVisionScenes", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try url.setResourceValues(values)
        return url
    }
    func localScenes() throws -> [VisionSceneManifest] {
        try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
            .compactMap { try? JSONDecoder().decode(VisionSceneManifest.self, from: Data(contentsOf: $0)) }.sorted { $0.createdAt > $1.createdAt }
    }
    func model(_ asset: VisionSceneAsset) throws -> ModelGeometry {
        try ModelGeometry(data: Data(contentsOf: root().appendingPathComponent(asset.id + ".atls"), options: .mappedIfSafe), manifest: asset.manifest)
    }
    func installAsset(_ file: URL, hash: String) throws {
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit }) else { throw TeachingError("空间资源标识无效") }
        let identity = try ModelFileIdentity.read(from: file)
        guard identity.modelHash == hash, identity.byteLength <= 192 * 1024 * 1024 else { throw TeachingError("空间资源校验失败") }
        let target = try root().appendingPathComponent(hash + ".atls")
        // Atomic replacement also repairs a previously interrupted cache file.
        try Data(contentsOf: file, options: .mappedIfSafe).write(to: target, options: .atomic)
    }
    func installManifest(_ manifest: VisionSceneManifest) throws {
        try manifest.validate()
        for asset in manifest.assets {
            let file = try root().appendingPathComponent(asset.id + ".atls")
            let identity = try ModelFileIdentity.read(from: file)
            guard identity.modelHash == asset.id, identity.byteLength == asset.manifest.byteLength else { throw TeachingError("空间资源不完整") }
        }
        try JSONEncoder().encode(manifest).write(to: root().appendingPathComponent(manifest.id + ".json"), options: .atomic)
    }
    func offers(address: String) async throws -> [VisionSceneOffer] {
        let base = try LANClient(address: address).baseURL
        let request = URLRequest(url: base.appendingPathComponent("__atlas/vision-scenes"))
        let (file, response) = try await LANClient.session.download(for: request)
        defer { try? FileManager.default.removeItem(at: file) }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              (try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? .max) <= 65536 else { throw TeachingError("电脑尚未提供空间工程，请重新启动服务") }
        struct Offers: Decodable { let scenes: [VisionSceneOffer] }
        return try JSONDecoder().decode(Offers.self, from: Data(contentsOf: file)).scenes
    }
    func download(_ offer: VisionSceneOffer, address: String,
                  progress: @Sendable @escaping (String) async -> Void) async throws -> VisionSceneManifest {
        guard UUID(uuidString: offer.id) != nil, offer.readToken.count == 64 else { throw TeachingError("空间工程下载凭据无效") }
        let base = try LANClient(address: address).baseURL.appendingPathComponent("__atlas/vision-scenes/\(offer.id)")
        func request(_ path: String) -> URLRequest {
            var request = URLRequest(url: base.appendingPathComponent(path)); request.setValue("Bearer \(offer.readToken)", forHTTPHeaderField: "Authorization"); return request
        }
        let (metadata, response) = try await LANClient.session.download(for: request("manifest"))
        defer { try? FileManager.default.removeItem(at: metadata) }
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              (try metadata.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? .max) <= 12 * 1024 * 1024 else { throw TeachingError("空间共享已关闭，请在电脑重新打开") }
        let manifest = try JSONDecoder().decode(VisionSceneManifest.self, from: Data(contentsOf: metadata))
        try manifest.validate(); guard manifest.id == offer.id else { throw TeachingError("空间工程标识不一致") }
        let folder = try root()
        for (index, asset) in manifest.assets.enumerated() {
            try Task.checkCancellation(); await progress("接收空间资源 \(index + 1) / \(manifest.assets.count)")
            let target = folder.appendingPathComponent(asset.id + ".atls")
            if let existing = try? ModelFileIdentity.read(from: target), existing.modelHash == asset.id, existing.byteLength == asset.manifest.byteLength { continue }
            let (temporary, response) = try await LANClient.session.download(for: request("assets/\(asset.id)"))
            defer { try? FileManager.default.removeItem(at: temporary) }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw TeachingError("空间资源下载中断，可重新接收以继续") }
            let identity = try ModelFileIdentity.read(from: temporary)
            guard identity.modelHash == asset.id, identity.byteLength == asset.manifest.byteLength else { throw TeachingError("空间资源校验失败") }
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.moveItem(at: temporary, to: target)
        }
        try JSONEncoder().encode(manifest).write(to: folder.appendingPathComponent(manifest.id + ".json"), options: .atomic)
        return manifest
    }
}
