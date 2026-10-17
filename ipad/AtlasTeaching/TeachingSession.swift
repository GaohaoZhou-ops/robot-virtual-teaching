import Foundation
import UIKit

struct PendingModelTransfer: Identifiable {
    let session: PairedSession
    let serverURL: String
    var thumbnail: Data?
    var previewError = ""
    var loadingPreview = false
    var id: String { session.id }
}

@MainActor
final class TeachingSession: ObservableObject {
    @Published var projects: [LocalProject] = []
    @Published var current: LocalProject?
    @Published var busy = false
    @Published private(set) var openingProjectID: String?
    @Published private(set) var deletingProjectID: String?
    @Published var error = ""
    @Published var status = ""
    @Published var serverConnection = LANAddressInput(address: UserDefaults.standard.string(forKey: "serverAddress") ?? "")
    var serverAddress: String {
        get { serverConnection.address }
        set { serverConnection = LANAddressInput(address: newValue) }
    }
    @Published var code = ""
    @Published var geometry: ModelGeometry?
    @Published private(set) var pendingModel: PendingModelTransfer?
    var displaySettings: ModelDisplaySettings { current?.displaySettings ?? ModelDisplaySettings() }
    private var saveTask: Task<Void, Never>?
    private var lastSaved = Date.distantPast
    private var deviceID: String {
        if let id = UserDefaults.standard.string(forKey: "deviceID") { return id }
        let id = UUID().uuidString; UserDefaults.standard.set(id, forKey: "deviceID"); return id
    }
    func reload() async {
        do { projects = try await ProjectStore.shared.projects() } catch { self.error = "读取本地草稿失败：\(error.localizedDescription)" }
    }
    #if os(iOS)
    func deleteLocalProject(_ project: LocalProject) async {
        guard !busy, current == nil, projects.contains(where: { $0.id == project.id }) else { return }
        busy = true; deletingProjectID = project.id; error = ""
        defer { busy = false; deletingProjectID = nil }
        // Drain earlier saves before removing files so an autosave cannot
        // recreate the deleted project. Deletion is only available in the library.
        await saveTask?.value; saveTask = nil
        status = "正在从此 iPad 删除模型与 Pose…"
        do {
            try await ProjectStore.shared.deleteLocalProject(project.id)
            projects.removeAll { $0.id == project.id }
            if !projects.contains(where: { $0.session.manifest.modelHash == project.session.manifest.modelHash }) {
                await ProjectThumbnailStore.shared.removeThumbnail(modelHash: project.session.manifest.modelHash)
            }
            status = "已从此 iPad 删除「\(project.session.manifest.name)」及全部 Pose；电脑工程和已同步结果保留"
        } catch {
            self.error = "本地删除未完成，请重试：\(error.localizedDescription)"
            status = "电脑工程和已同步结果不受影响"
        }
    }
    #endif
    func pair(qr: PairingQRCode? = nil, confirmNewModel: Bool = false) async {
        guard !busy else { return }; busy = true; error = ""; defer { busy = false }
        do {
            pendingModel = nil
            if let qr { try qr.validate(); serverAddress = qr.address; code = PairingCode.normalize(qr.code) }
            let client = try LANClient(address: qr?.address ?? serverAddress)
            status = "连接电脑并配对…"
            let paired = try await client.pair(code: code, deviceID: deviceID, name: TeachingDevice.current.model, qr: qr)
            if confirmNewModel {
                status = "配对成功，正在校验本地模型…"
                if let local = try await ProjectStore.shared.matchingModel(paired.manifest, preferredID: paired.id) {
                    let data = try await ProjectStore.shared.model(local.id)
                    try await acceptModel(data, paired: paired, serverURL: client.baseURL.absoluteString)
                    status = "本地已存在一致模型，已直接使用"
                } else {
                    pendingModel = PendingModelTransfer(session: paired, serverURL: client.baseURL.absoluteString)
                    status = "配对成功，发现新模型，等待确认同步"
                }
                return
            }
            status = "通过局域网下载物体…"
            let data = try await client.download(paired)
            try await acceptModel(data, paired: paired, serverURL: client.baseURL.absoluteString)
        } catch { self.error = "接收失败：\(error.localizedDescription)"; status = "请检查局域网地址、配对码与本地网络权限" }
    }
    private func acceptModel(_ data: Data, paired: PairedSession, serverURL: String) async throws {
        let geometry = try await Task.detached { try ModelGeometry(data: data, manifest: paired.manifest) }.value
        let existing = try await ProjectStore.shared.projects().first { $0.id == paired.id }
        var project = existing ?? LocalProject(serverURL: serverURL, session: paired,
            result: TeachingResult(sessionId: paired.id, modelHash: paired.manifest.modelHash))
        project.displaySettings = project.displaySettings ?? ModelDisplaySettings().forOpening()
        project.session = paired; project.serverURL = serverURL
        project.resultSyncDestination = nil
        try await ProjectStore.shared.saveModel(data, id: paired.id)
        try await ProjectStore.shared.save(project)
        UserDefaults.standard.set(serverURL, forKey: "serverAddress")
        self.geometry = geometry; current = project; pendingModel = nil
        status = "物体已保存到 \(TeachingDevice.storageName)，可以断开网络"
        await reload()
    }
    func loadPendingPreview() async {
        guard let pending = pendingModel, pending.thumbnail == nil, !pending.loadingPreview else { return }
        pendingModel?.loadingPreview = true; pendingModel?.previewError = ""
        defer { if pendingModel?.id == pending.id { pendingModel?.loadingPreview = false } }
        do {
            let image = try await LANClient(address: pending.serverURL).modelThumbnail(pending.session)
            try Task.checkCancellation()
            guard pendingModel?.id == pending.id, UIImage(data: image) != nil else { throw TeachingError("模型预览无效") }
            pendingModel?.thumbnail = image
        } catch {
            if !Task.isCancelled, pendingModel?.id == pending.id { pendingModel?.previewError = "预览加载失败，可重试或直接同步模型" }
        }
    }
    func syncPendingModel() async {
        guard !busy, let pending = pendingModel else { return }
        busy = true; error = ""; status = "正在同步模型…"; defer { busy = false }
        do {
            let data = try await LANClient(address: pending.serverURL).download(pending.session)
            try await acceptModel(data, paired: pending.session, serverURL: pending.serverURL)
        } catch { self.error = "模型同步失败，可重试：\(error.localizedDescription)"; status = "等待重试同步模型" }
    }
    func open(_ project: LocalProject) async {
        guard !busy else { return }; busy = true; error = ""; openingProjectID = project.id
        defer { busy = false; openingProjectID = nil }
        do {
            let data = try await ProjectStore.shared.model(project.id)
            geometry = try await Task.detached(priority: .userInitiated) { try ModelGeometry(data: data, manifest: project.session.manifest) }.value
            var opened = project
            opened.displaySettings = project.displaySettings ?? ModelDisplaySettings().forOpening()
            current = opened; pendingModel = nil
            serverAddress = project.resultSyncDestination?.serverURL ?? project.serverURL
            #if os(iOS)
            status = ""
            #else
            status = project.result.completedAt == nil ? "" : "示教已完成，等待同步或已同步"
            #endif
        } catch { self.error = error.localizedDescription }
    }
    func continueTeaching() async {
        guard !busy, let project = current, project.result.completedAt != nil else { return }
        busy = true; error = ""; status = "正在保留已有 Pose 并创建补录草稿…"
        defer { busy = false }
        do {
            try await saveNow()
            let draft = try await ProjectStore.shared.continueTeaching(project)
            current = draft
            #if os(iOS)
            status = ""
            #else
            status = "已保留 \(draft.result.samples.count) 个 Pose，请重新放置物体后继续记录；原完成结果保留在本地项目"
            #endif
            await reload()
        } catch {
            self.error = "创建补录草稿失败：\(error.localizedDescription)"
            status = "原完成结果仍保留，可重试"
        }
    }
    func addCalibration(_ calibration: Calibration) {
        guard current?.result.completedAt == nil else { return }
        current?.result.calibrations.append(calibration); scheduleSave(force: true)
    }
    func setDisplaySettings(_ settings: ModelDisplaySettings) {
        guard current != nil, settings != displaySettings else { return }
        current?.displaySettings = settings
        scheduleSave(force: true)
    }
    @discardableResult
    func addSample(_ sample: TeachingSample) -> Bool {
        guard !busy, error.isEmpty, let project = current, project.result.completedAt == nil,
              project.result.samples.count < maximumSamples,
              project.result.calibrations.contains(where: { $0.id == sample.segmentId }),
              !project.result.samples.contains(where: { $0.id == sample.id }) else { return false }
        var named = sample
        named.name = String(format: "Pose %03d", project.result.samples.count + 1)
        current?.result.samples.append(named); scheduleSave(force: true)
        return true
    }
    func renameSample(_ id: String, name: String) {
        guard current?.result.completedAt == nil, let index = current?.result.samples.firstIndex(where: { $0.id == id }) else { return }
        let value = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80))
        if !value.isEmpty { current?.result.samples[index].name = value; scheduleSave(force: true) }
    }
    func deleteSample(_ id: String) {
        deleteSamples([id])
    }
    func deleteSamples(_ ids: Set<String>) {
        guard !busy, !ids.isEmpty, let project = current, project.result.completedAt == nil else { return }
        let remaining = project.result.samples.filter { !ids.contains($0.id) }
        guard remaining.count != project.result.samples.count else { return }
        current?.result.samples = remaining
        scheduleSave(force: true)
    }
    private func scheduleSave(force: Bool = false) {
        guard let project = current, force || Date().timeIntervalSince(lastSaved) >= 1 else { return }
        lastSaved = Date()
        let prior = saveTask
        saveTask = Task {
            await prior?.value
            do { try await ProjectStore.shared.save(project); status = "已自动保存到 \(TeachingDevice.storageName) · \(project.result.samples.count) 个采样" }
            catch { self.error = "本地保存失败：\(error.localizedDescription)" }
        }
    }
    func saveNow() async throws {
        await saveTask?.value
        if let current { try await ProjectStore.shared.save(current) }
    }
    func backgroundSave() {
        let identifier = UIApplication.shared.beginBackgroundTask(expirationHandler: nil)
        Task {
            do { try await saveNow() } catch { self.error = error.localizedDescription }
            if identifier != .invalid { UIApplication.shared.endBackgroundTask(identifier) }
        }
    }
    func close() async {
        guard !busy else { return }
        do { try await saveNow(); current = nil; geometry = nil; pendingModel = nil; status = ""; await reload() }
        catch { self.error = "保存失败，草稿仍在当前界面：\(error.localizedDescription)" }
    }
    func exportResult() async -> URL? {
        guard !busy, let project = current else { return nil }
        busy = true; error = ""; status = "正在校验模型并导出示教结果…"
        defer { busy = false }
        do {
            try await saveNow()
            let url = try await ProjectStore.shared.exportResult(project)
            status = "结果文件已导出；可通过 AirDrop 分享，或在 Finder 的「文件」中拷贝 Teaching Exports"
            return url
        } catch {
            self.error = "导出失败，本地结果仍保留：\(error.localizedDescription)"
            status = "尚未导出，可重试"
            return nil
        }
    }
    func resultShareFinished(activity: UIActivity.ActivityType?, completed: Bool, error: Error?) {
        // The share sheet cannot acknowledge an import into the browser workspace.
        // Only a verified LAN receipt may set LocalProject.syncedAt.
        if let error {
            self.error = "分享失败，结果文件仍保留，可重试：\(error.localizedDescription)"
            status = "尚未确认分享成功"
        } else if completed {
            status = activity == .airDrop
                ? "AirDrop 已发送；请在电脑「iPad / Vision Pro」窗口导入结果文件"
                : "结果文件已分享；请在电脑「iPad / Vision Pro」窗口导入结果文件"
        } else {
            status = "已取消分享；结果文件仍保留，可再次分享或通过 Finder 拷贝"
        }
    }
    func syncResult(qr: PairingQRCode) async {
        guard !busy, var project = current, project.result.completedAt != nil else { return }
        busy = true; error = ""; status = "正在连接二维码中的电脑并核对模型…"
        defer { busy = false }
        do {
            try await saveNow()
            let client = try LANClient(address: qr.address)
            let modelURL = try await ProjectStore.shared.modelURL(project.id)
            let destination = try await client.pairResult(project, modelURL: modelURL, qr: qr,
                deviceID: deviceID, name: TeachingDevice.current.model)
            project.resultSyncDestination = ResultSyncDestination(serverURL: client.baseURL.absoluteString, session: destination)
            project.syncedAt = nil
            // Persist credentials before sending so a lost response or app restart
            // can retry the same result, even after the QR expires.
            try await ProjectStore.shared.save(project); current = project
            serverAddress = client.baseURL.absoluteString
            UserDefaults.standard.set(serverAddress, forKey: "serverAddress")
            try await client.upload(project, modelURL: modelURL) { self.status = "模型一致，正在上传 Pose…" }
            project.syncedAt = timestamp()
            try await ProjectStore.shared.save(project); current = project
            status = "扫码同步成功，请在电脑点击「接收示教结果」"
            await reload()
        } catch {
            self.error = "扫码同步失败，本地 Pose 仍保留：\(error.localizedDescription)"
            status = "可重新扫码；已连接的任务也可使用局域网按钮重试"
        }
    }
    func finish(sync: Bool) async {
        guard !busy, var project = current, !project.result.samples.isEmpty else { return }
        busy = true; error = ""; defer { busy = false }
        do {
            guard !sync || project.result.device.platform != "visionOS-simulator" else {
                throw TeachingError("模拟演练数据只能保存在本机，不能同步")
            }
            guard !sync || !project.requiresResultPairing else {
                throw TeachingError("补录结果需要新的传输任务，请在电脑点击「新建传输」，再使用「扫码同步到电脑」")
            }
            await saveTask?.value
            if project.result.completedAt == nil { project.result.completedAt = timestamp() }
            // Freeze before any network call. A failed/ambiguous upload can retry the same bytes.
            current = project; try await ProjectStore.shared.save(project)
            if sync {
                let client = try LANClient(address: serverAddress)
                if project.resultSyncDestination != nil { project.resultSyncDestination?.serverURL = client.baseURL.absoluteString }
                else { project.serverURL = client.baseURL.absoluteString }
                current = project
                try await ProjectStore.shared.save(project)
                status = "正在核对 \(TeachingDevice.storageName) 与电脑的模型文件…"
                let modelURL = try await ProjectStore.shared.modelURL(project.id)
                try await client.upload(project, modelURL: modelURL) {
                    self.status = "模型一致，正在通过局域网上传 Pose…"
                }
                project.syncedAt = timestamp(); current = project; try await ProjectStore.shared.save(project)
                status = "同步成功，请在电脑端点击「检查完成状态」并接收结果"
            } else {
                #if os(iOS)
                status = ""
                #else
                status = "示教已完成并保存在 \(TeachingDevice.storageName)，可稍后同步到电脑"
                #endif
            }
            await reload()
        } catch { self.error = "结果保留在 \(TeachingDevice.storageName)，可重试：\(error.localizedDescription)"; status = "尚未确认同步成功" }
    }
}
