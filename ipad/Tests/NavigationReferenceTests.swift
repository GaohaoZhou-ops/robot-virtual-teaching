import Foundation
import SceneKit

@main struct NavigationReferenceTests {
    static func main() async throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let decoder = JSONDecoder(), encoder = JSONEncoder()
        let data = try Data(contentsOf: directory.appendingPathComponent("paired.json"))
        let paired = try decoder.decode(PairedSession.self, from: data)
        let reference = paired.navigationReference!
        try reference.validate()
        precondition(reference.parkingPoints.count == 3 && reference.paths.count == 1)
        precondition(reference.parkingPoints.last?.name == "本地停车点")
        let expected = try decoder.decode([[Float]].self, from: Data(contentsOf: directory.appendingPathComponent("transforms.json")))
        let root = ParkingReferenceRenderer.makeNode(reference)
        for (index, point) in reference.parkingPoints.enumerated() {
            let marker = root.childNode(withName: "parking-reference-\(point.id)", recursively: false)!
            precondition(zip(marker.simdTransform.elements, expected[index]).allSatisfy { abs($0 - $1) < 1e-5 },
                         "SceneKit retains desktop position, height and full orientation")
            let placement = TeachingCoordinates.placement(hit: SIMD3(4, 1, -3), reference: SIMD3(0.1, -0.2, 0.3), yaw: 37, roll: 12, pitch: -21)
            root.simdTransform = placement
            let wanted = placement * simd_float4x4(elements: expected[index])
            precondition(zip(marker.simdWorldTransform.elements, wanted.elements).allSatisfy { abs($0 - $1) < 1e-5 },
                         "Parking moves with the same AR placement as the model")
            precondition(root.childNode(withName: "parking-label-\(point.id)", recursively: false)?.constraints?.count == 1)
        }
        let bounds = ParkingReferenceRenderer.bounds(reference, minimum: SCNVector3(-0.4, -0.3, -0.6), maximum: SCNVector3(0.4, 0.3, 0.6))
        for point in reference.parkingPoints {
            precondition(Float(bounds.min.x) <= point.position.x && Float(bounds.max.x) >= point.position.x)
            precondition(Float(bounds.min.z) <= point.position.z && Float(bounds.max.z) >= point.position.z)
        }
        var result = TeachingResult(sessionId: paired.id, modelHash: paired.manifest.modelHash)
        result.completedAt = timestamp()
        let project = LocalProject(serverURL: "", session: paired, result: result)
        let store = ProjectStore(directory: directory.appendingPathComponent("projects"))
        try await store.saveModel(Data(contentsOf: directory.appendingPathComponent("model.atls")), id: project.id)
        try await store.save(project)
        let reopened = try await store.projects().first!
        precondition(reopened.session.navigationReference == reference, "offline reopening preserves the complete graph")
        let continued = try await store.continueTeaching(reopened)
        precondition(continued.session.navigationReference == reference, "continuations retain read-only parking")
        precondition(continued.result.samples.isEmpty, "parking never becomes editable camera poses")
        let portable = try encoder.encode(TeachingResultFile(manifest: paired.manifest, result: continued.result))
        precondition(!String(decoding: portable, as: UTF8.self).contains("navigationReference"), "results cannot overwrite workstation navigation")

        var legacy = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        legacy.removeValue(forKey: "navigationReference")
        let old = try decoder.decode(PairedSession.self, from: JSONSerialization.data(withJSONObject: legacy))
        precondition(old.navigationReference == nil, "old projects remain readable")
        precondition(ParkingReferenceRenderer.makeNode(nil).childNodes.isEmpty)
        for badField in ["position", "quaternion", "id", "path", "frame"] {
            var invalid = try JSONSerialization.jsonObject(with: encoder.encode(reference)) as! [String: Any]
            var points = invalid["parkingPoints"] as! [[String: Any]]
            if badField == "position" { points[0]["position"] = ["x": "invalid", "y": 0, "z": 0] }
            if badField == "quaternion" { points[0]["quaternion"] = ["x": 0, "y": 0, "z": 0, "w": 2] }
            if badField == "id" { points[1]["id"] = points[0]["id"] }
            if badField == "path" { invalid["paths"] = [["id": "bad", "from": "missing", "to": "missing", "directed": true]] }
            if badField == "frame" { invalid["coordinateFrame"] = "map" }
            invalid["parkingPoints"] = points
            do {
                try decoder.decode(NavigationReference.self, from: JSONSerialization.data(withJSONObject: invalid)).validate()
                preconditionFailure("invalid navigation accepted: \(badField)")
            } catch { }
        }
        print("Native parking references: transforms, AR placement, fitting, offline storage, continuations, legacy data and result isolation passed.")
    }
}
