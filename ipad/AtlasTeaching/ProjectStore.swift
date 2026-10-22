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
    private func exportsURL() throws -> URL {
        if let exportDirectory { return exportDirectory }
        return try FileManager.default.url(for: .documentDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent("Teaching Exports", isDirectory: true)
    }
    func deleteLocalProject(_ id: String) throws {
        let metadata = try file(id, ext: "json"), model = try file(id, ext: "atls")
        let manager = FileManager.default
        var files: [URL] = []
        if manager.fileExists(atPath: metadata.path) {
            let project = try JSONDecoder().decode(LocalProject.self, from: Data(contentsOf: metadata))
            guard project.id == id, UUID(uuidString: project.result.id) != nil else {
                throw TeachingError("本地项目标识不匹配，未执行删除")
            }
            let exports = try exportsURL()
            if manager.fileExists(atPath: exports.path) {
                // Only this result's app-generated copies on this device. Never
                // follow a server URL or match other projects by model hash/name.
                let suffix = "-\(project.result.id).atlas-teaching.json"
                files = try manager.contentsOfDirectory(at: exports, includingPropertiesForKeys: nil).filter {
                    $0.lastPathComponent.hasPrefix("Atlas-") && $0.lastPathComponent.hasSuffix(suffix)
                }
            }
        }
        // Keep metadata until all payloads are removed. If removal fails, the
        // visible row can retry even when some files have already been removed.
        for url in files + [model, metadata] where manager.fileExists(atPath: url.path) {
            try manager.removeItem(at: url)
        }
    }
    func continueTeaching(_ project: LocalProject, removingSampleIDs: Set<String> = []) throws -> LocalProject {
        guard project.result.completedAt != nil else { throw TeachingError("当前项目仍是草稿，可直接继续示教") }
        guard removingSampleIDs.isSubset(of: Set(project.result.samples.map(\.id))) else {
            throw TeachingError("所选 Pose 已变化，请重新选择")
        }
        let source = try file(project.id, ext: "atls")
        let identity = try ModelFileIdentity.read(from: source)
        guard project.result.sessionId == project.id,
              identity.modelHash == project.session.manifest.modelHash,
              identity.modelHash == project.result.modelHash,
              identity.byteLength == project.session.manifest.byteLength else {
            throw TeachingError("本地模型与完成结果不匹配，无法创建补录草稿")
        }
        // Completed results are immutable on the desktop and deduplicated by ID.
        // Keep the original project. Filtering the copy before saving makes a
        // batch edit atomic: no partially edited draft can appear after failure.
        let id = UUID().uuidString
        var result = project.result
        result.id = UUID().uuidString; result.sessionId = id
        result.createdAt = timestamp(); result.completedAt = nil
        result.samples.removeAll { removingSampleIDs.contains($0.id) }
        let draft = LocalProject(serverURL: project.serverURL,
            session: PairedSession(id: id, deviceToken: "", manifest: project.session.manifest,
                                   navigationReference: project.session.navigationReference), result: result,
            displaySettings: project.displaySettings ?? ModelDisplaySettings().forOpening())
        let destination = try file(id, ext: "atls")
        try FileManager.default.copyItem(at: source, to: destination)
        do { try save(draft) }
        catch { try? FileManager.default.removeItem(at: destination); throw error }
        return draft
    }
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
        let exports = try exportsURL()
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
