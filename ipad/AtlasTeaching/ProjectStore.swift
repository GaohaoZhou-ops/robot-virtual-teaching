import Foundation

// A serial actor orders writes so a delayed autosave cannot replace a completed result.
actor ProjectStore {
    static let shared = ProjectStore()
    private let directory: URL?
    private let exportDirectory: URL?
    init(directory: URL? = nil, exportDirectory: URL? = nil) {
        self.directory = directory; self.exportDirectory = exportDirectory
    }
    private func root() throws -> URL {
        var root: URL
        if let directory { root = directory }
        else { root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AtlasTeaching", isDirectory: true) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
        return root
    }
    private func file(_ id: String, ext: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw TeachingError("本地任务标识无效") }
        return try root().appendingPathComponent(id).appendingPathExtension(ext)
    }
    func save(_ project: LocalProject) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(project).write(to: file(project.id, ext: "json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func saveModel(_ data: Data, id: String) throws { try data.write(to: file(id, ext: "atls"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    func model(_ id: String) throws -> Data { try Data(contentsOf: file(id, ext: "atls"), options: .mappedIfSafe) }
    func modelURL(_ id: String) throws -> URL { try file(id, ext: "atls") }
    func exportResult(_ project: LocalProject) throws -> URL {
        guard project.result.completedAt != nil else { throw TeachingError("请先完成示教，再导出结果") }
        guard !project.result.samples.isEmpty, project.result.samples.count <= maximumSamples,
              !project.result.calibrations.isEmpty, project.result.calibrations.count <= 1000 else {
            throw TeachingError("示教结果缺少 Pose 或校准，或数量超出限制")
        }
        guard project.result.device.platform != "visionOS-simulator" else {
            throw TeachingError("模拟演练数据只能保存在本机，不能导出同步")
        }
        let manifest = project.session.manifest
        guard UUID(uuidString: project.result.id) != nil,
              project.result.protocol == teachingProtocol, manifest.protocol == teachingProtocol,
              project.result.sessionId == project.id, project.result.modelHash == manifest.modelHash,
              project.result.coordinateFrame == "virtual_origin", manifest.coordinateFrame == "virtual_origin",
              manifest.distanceUnit == "meter", manifest.verticalAxis == "Z" else {
            throw TeachingError("示教结果与本地模型信息不匹配，无法导出")
        }
        // Hash the actual file on this actor, away from the UI, just as LAN sync does.
        let identity = try ModelFileIdentity.read(from: file(project.id, ext: "atls"))
        guard identity.modelHash == manifest.modelHash, identity.byteLength == manifest.byteLength else {
            throw TeachingError("本地模型内容已改变，无法导出；本地 Pose 仍保留")
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(TeachingResultFile(manifest: manifest, result: project.result))
        guard data.count <= 64 * 1024 * 1024 else { throw TeachingError("示教结果文件超过 64 MiB，无法导出") }
        let exports: URL
        if let exportDirectory { exports = exportDirectory }
        else {
            exports = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
                appropriateFor: nil, create: true).appendingPathComponent("Teaching Exports", isDirectory: true)
        }
        try FileManager.default.createDirectory(at: exports, withIntermediateDirectories: true)
        let stem = String(manifest.name.components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }.joined(separator: "-").prefix(60))
        let url = exports.appendingPathComponent("Atlas-\(stem.isEmpty ? "Teaching" : stem)-\(project.result.id).atlas-teaching.json")
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return url
    }
    func matchingModel(_ manifest: ModelManifest, preferredID: String? = nil) throws -> LocalProject? {
        let candidates = try projects().filter {
            $0.session.manifest.modelHash == manifest.modelHash && $0.session.manifest.byteLength == manifest.byteLength
        }.sorted { $0.id == preferredID && $1.id != preferredID }
        for candidate in candidates {
            try Task.checkCancellation()
            // Metadata only narrows the search. Re-read the actual file before reuse.
            guard let identity = try? ModelFileIdentity.read(from: file(candidate.id, ext: "atls")),
                  identity.modelHash == manifest.modelHash, identity.byteLength == manifest.byteLength else { continue }
            return candidate
        }
        try Task.checkCancellation()
        return nil
    }
    func projects() throws -> [LocalProject] {
        let files = try FileManager.default.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil).filter { $0.pathExtension == "json" }
        return try files.map { try JSONDecoder().decode(LocalProject.self, from: Data(contentsOf: $0)) }
            .sorted { $0.result.createdAt > $1.result.createdAt }
    }
}
