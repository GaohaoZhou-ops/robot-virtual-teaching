import Foundation
import simd

@main struct ResultFileTests {
    static func main() async throws {
        let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
        let directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let exports = URL(fileURLWithPath: CommandLine.arguments[3])
        let store = ProjectStore(directory: directory, exportDirectory: exports)
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: fixture.appendingPathExtension("json")))
        let model = try Data(contentsOf: fixture.appendingPathExtension("atls"))
        let id = UUID().uuidString
        let calibration = Calibration(worldFromModel: TeachingCoordinates.zUpToAR.elements,
            referencePoint: Point3(.zero), yawDegrees: 0)
        var result = TeachingResult(sessionId: id, modelHash: manifest.modelHash)
        result.calibrations = [calibration]
        result.samples = [TeachingSample(name: "Pose 001", segmentId: calibration.id, kind: "keyframe",
            cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR),
            surfacePoint: Point3(SIMD3(1, 2, 3)), previewCameraTransform: matrix_identity_float4x4.elements,
            previewProjection: matrix_identity_float4x4.elements, previewAspect: 4.0 / 3.0)]
        var project = LocalProject(serverURL: "http://192.168.7.42:21990",
            session: PairedSession(id: id, deviceToken: "PRIVATE-PAIRING-SECRET", manifest: manifest), result: result)
        try await store.saveModel(model, id: id)
        try await store.save(project)
        do { _ = try await store.exportResult(project); preconditionFailure("unfinished results were exported") }
        catch let error as TeachingError { precondition(error.message.contains("请先完成")) }
        do { _ = try await store.continueTeaching(project); preconditionFailure("an unfinished draft was duplicated") }
        catch let error as TeachingError { precondition(error.message.contains("仍是草稿")) }
        project.result.completedAt = timestamp()
        try await store.save(project)
        let saved = try Data(contentsOf: directory.appendingPathComponent(id).appendingPathExtension("json"))
        let url = try await store.exportResult(project)
        let data = try Data(contentsOf: url)
        let text = String(decoding: data, as: UTF8.self)
        precondition(!text.contains("PRIVATE-PAIRING-SECRET") && !text.contains(project.serverURL))
        let decoded = try JSONDecoder().decode(TeachingResultFile.self, from: data)
        precondition(decoded.format == "atlas-teaching-result" && decoded.version == 1)
        precondition(decoded.result.id == result.id && decoded.result.samples.count == 1)
        precondition(decoded.result.samples[0].previewProjection == matrix_identity_float4x4.elements)
        let retryURL = try await store.exportResult(project)
        let retryData = try Data(contentsOf: retryURL)
        precondition(retryURL == url && retryData == data, "retries preserve the frozen result")

        var sourceForContinuation = project
        sourceForContinuation.syncedAt = timestamp()
        sourceForContinuation.resultSyncDestination = ResultSyncDestination(serverURL: project.serverURL, session: project.session)
        let draft = try await store.continueTeaching(sourceForContinuation)
        precondition(draft.id != project.id && draft.result.id != project.result.id)
        precondition(draft.result.sessionId == draft.id && draft.result.completedAt == nil)
        precondition(draft.syncedAt == nil && draft.resultSyncDestination == nil && draft.requiresResultPairing)
        precondition(draft.session.deviceToken.isEmpty, "a continuation cannot overwrite a completed desktop transfer")
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let draftSamples = try encoder.encode(draft.result.samples), originalSamples = try encoder.encode(project.result.samples)
        let draftCalibrations = try encoder.encode(draft.result.calibrations), originalCalibrations = try encoder.encode(project.result.calibrations)
        precondition(draftSamples == originalSamples, "all Pose fields survive")
        precondition(draftCalibrations == originalCalibrations, "calibration IDs survive")
        let draftModel = try await store.model(draft.id)
        precondition(draftModel == model, "the continuation retains the exact model")
        let reopened = try await store.projects().first { $0.id == draft.id }
        precondition(reopened?.result.id == draft.result.id && reopened?.requiresResultPairing == true)
        var rePaired = draft
        rePaired.resultSyncDestination = ResultSyncDestination(serverURL: project.serverURL, session: project.session)
        precondition(!rePaired.requiresResultPairing, "after QR pairing, LAN retry is available")
        do { _ = try await store.exportResult(draft); preconditionFailure("continuation exported before completion") }
        catch let error as TeachingError { precondition(error.message.contains("请先完成")) }

        var changedModel = model; changedModel[model.count - 1] ^= 1
        try await store.saveModel(changedModel, id: id)
        do { _ = try await store.exportResult(project); preconditionFailure("changed model exported") }
        catch let error as TeachingError { precondition(error.message.contains("本地模型内容")) }
        do { _ = try await store.continueTeaching(project); preconditionFailure("a changed model was used for continuation") }
        catch let error as TeachingError { precondition(error.message.contains("不匹配")) }
        let modelURL = try await store.modelURL(id)
        try FileManager.default.removeItem(at: modelURL)
        do { _ = try await store.exportResult(project); preconditionFailure("missing model exported") }
        catch let error as TeachingError { precondition(error.message.contains("无法读取")) }
        try await store.saveModel(model, id: id)
        var invalid = project; invalid.result.modelHash = String(repeating: "0", count: 64)
        do { _ = try await store.exportResult(invalid); preconditionFailure("mismatched result exported") }
        catch let error as TeachingError { precondition(error.message.contains("不匹配")) }
        invalid = project; invalid.result.device.platform = "visionOS-simulator"
        do { _ = try await store.exportResult(invalid); preconditionFailure("simulator data exported") }
        catch let error as TeachingError { precondition(error.message.contains("模拟演练")) }
        let savedAfter = try Data(contentsOf: directory.appendingPathComponent(id).appendingPathExtension("json"))
        let projects = try await store.projects()
        precondition(saved == savedAfter && projects.count == 2 && projects.allSatisfy { $0.syncedAt == nil },
            "export/continuation leave the original frozen result intact, and failed continuation creates no project")
        let finalData = try Data(contentsOf: url)
        precondition(finalData == data, "failed exports retain the previous shareable file")
        print(url.path)
    }
}
