import Foundation
import simd

@main struct LocalProjectDeletionTests {
    static func main() async throws {
        let fixture = URL(fileURLWithPath: CommandLine.arguments[1])
        let root = URL(fileURLWithPath: CommandLine.arguments[2])
        let directory = root.appendingPathComponent("ipad")
        let exports = root.appendingPathComponent("ipad-exports")
        let desktop = root.appendingPathComponent("desktop")
        let store = ProjectStore(directory: directory, exportDirectory: exports)
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: fixture.appendingPathExtension("json")))
        let model = try Data(contentsOf: fixture.appendingPathExtension("atls"))
        let calibration = Calibration(worldFromModel: TeachingCoordinates.zUpToAR.elements,
            referencePoint: Point3(.zero), yawDegrees: 0)
        let sample = TeachingSample(name: "Pose 001", segmentId: calibration.id, kind: "keyframe",
            cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR))
        func project(completed: Bool) -> LocalProject {
            let id = UUID().uuidString
            var result = TeachingResult(sessionId: id, modelHash: manifest.modelHash)
            result.calibrations = [calibration]; result.samples = [sample]
            result.completedAt = completed ? timestamp() : nil
            return LocalProject(serverURL: "http://127.0.0.1:1",
                session: PairedSession(id: id, deviceToken: "desktop-credentials", manifest: manifest), result: result,
                syncedAt: completed ? timestamp() : nil)
        }
        let completed = project(completed: true), sibling = project(completed: true), draft = project(completed: false)
        for project in [completed, sibling, draft] {
            try await store.saveModel(model, id: project.id); try await store.save(project)
        }
        let completedExport = try await store.exportResult(completed)
        let siblingExport = try await store.exportResult(sibling)
        let renamedExport = exports.appendingPathComponent("Atlas-renamed-\(completed.result.id).atlas-teaching.json")
        try FileManager.default.copyItem(at: completedExport, to: renamedExport)
        // Model names/hashes are identical; deletion must use the selected local ID.
        let siblingMetadata = directory.appendingPathComponent(sibling.id).appendingPathExtension("json")
        let siblingBefore = try Data(contentsOf: siblingMetadata)
        let siblingExportBefore = try Data(contentsOf: siblingExport)
        try FileManager.default.createDirectory(at: desktop, withIntermediateDirectories: true)
        let desktopModel = desktop.appendingPathComponent("model.atls"), desktopResult = desktop.appendingPathComponent("result.json")
        try model.write(to: desktopModel)
        let receivedResult = try Data(contentsOf: completedExport); try receivedResult.write(to: desktopResult)

        try await store.deleteLocalProject(completed.id)
        for url in [directory.appendingPathComponent(completed.id).appendingPathExtension("json"),
                    directory.appendingPathComponent(completed.id).appendingPathExtension("atls"), completedExport, renamedExport] {
            precondition(!FileManager.default.fileExists(atPath: url.path), "selected model, Poses and local exports must be removed")
        }
        let siblingAfter = try Data(contentsOf: siblingMetadata), siblingExportAfter = try Data(contentsOf: siblingExport)
        let siblingModel = try await store.model(sibling.id)
        precondition(siblingBefore == siblingAfter && siblingExportBefore == siblingExportAfter && siblingModel == model)
        let desktopModelAfter = try Data(contentsOf: desktopModel), desktopResultAfter = try Data(contentsOf: desktopResult)
        precondition(desktopModelAfter == model && desktopResultAfter == receivedResult, "desktop files remain byte-for-byte unchanged")
        try await store.deleteLocalProject(completed.id) // Retrying an already removed item is harmless.
        let reopened = ProjectStore(directory: directory, exportDirectory: exports)
        let remaining = try await reopened.projects()
        precondition(Set(remaining.map(\.id)) == Set([sibling.id, draft.id]), "deleted data cannot reappear on reopening")
        let reusable = try await reopened.matchingModel(manifest)
        precondition(reusable != nil, "the other local copy can still be reused")

        // An interrupted removal with a missing model can still finish deleting its metadata.
        let draftModel = try await store.modelURL(draft.id)
        try FileManager.default.removeItem(at: draftModel)
        try await store.deleteLocalProject(draft.id)
        do { try await store.deleteLocalProject("../desktop/model"); preconditionFailure("invalid paths were accepted") }
        catch let error as TeachingError { precondition(error.message.contains("标识无效")) }
        let finalProjects = try await reopened.projects()
        precondition(finalProjects.count == 1 && finalProjects[0].id == sibling.id)
        let desktopFinal = try Data(contentsOf: desktopResult)
        precondition(desktopFinal == receivedResult)
        print("Local project deletion passed: model/Pose/export cleanup, sibling isolation, desktop preservation, restart and retry.")
    }
}
