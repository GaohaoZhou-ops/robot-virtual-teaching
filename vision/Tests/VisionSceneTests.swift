import Foundation
import simd

@main struct VisionSceneTests {
    struct Expected: Decodable { let milliseconds: Double; let pose: VisionScenePose; let joints: [String: Float]; let tip: [Float] }
    static func close(_ a: simd_float4x4, _ b: simd_float4x4) {
        for (a, b) in zip(a.elements, b.elements) { precondition(abs(a - b) < 0.0002, "Native robot transform differs from desktop") }
    }
    static func main() async throws {
        navigation()
        let base = CommandLine.arguments[1], directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let decoder = JSONDecoder(), data = try Data(contentsOf: directory.appendingPathComponent("scene.json"))
        let scene = try decoder.decode(VisionSceneManifest.self, from: data); try scene.validate()
        let expected = try decoder.decode([Expected].self, from: Data(contentsOf: directory.appendingPathComponent("expected.json")))
        for sample in expected {
            let (pose, values) = scene.clips[0].sample(milliseconds: sample.milliseconds)
            close(pose.matrix, sample.pose.matrix)
            for (key, value) in sample.joints { precondition(abs((values[key] ?? .infinity) - value) < 0.0002) }
            var world: [String: simd_float4x4] = [:]
            for node in scene.nodes {
                let local = node.id == scene.robotRoot ? pose.matrix : node.joint.map { $0.matrix(value: values[$0.name] ?? $0.value) } ?? simd_float4x4(elements: node.transform)
                world[node.id] = (node.parent.flatMap { world[$0] } ?? matrix_identity_float4x4) * local
                if node.name == "检查相机" { close(world[node.id]!, simd_float4x4(elements: sample.tip)) }
            }
        }
        for mutation in 0..<5 {
            var object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            var nodes = object["nodes"] as! [[String: Any]]
            if mutation == 0 { nodes[0]["parent"] = "missing" }
            if mutation == 1 { nodes[0]["transform"] = [0, 1] }
            if mutation == 2 { nodes[0]["role"] = "invalid" }
            if mutation == 3 { object["id"] = "../../outside" }
            if mutation == 4 { var assets = object["assets"] as! [[String: Any]]; assets[0]["vertices"] = -1; object["assets"] = assets }
            object["nodes"] = nodes
            do { try decoder.decode(VisionSceneManifest.self, from: JSONSerialization.data(withJSONObject: object)).validate(); preconditionFailure("Invalid scene accepted") } catch {}
        }
        let store = VisionSceneStore(directory: directory.appendingPathComponent("device"))
        let offers = try await store.offers(address: base); precondition(offers.count == 1)
        let downloaded = try await store.download(offers[0], address: base) { _ in }; try downloaded.validate()
        for asset in scene.assets { let model = try await store.model(asset); precondition(model.vertices == asset.manifest.vertices) }
        _ = try await store.download(offers[0], address: base) { _ in }
        let broken = directory.appendingPathComponent("device/\(scene.assets[0].id).atls")
        try Data([0, 1, 2]).write(to: broken)
        _ = try await store.download(offers[0], address: base) { _ in }
        let cached = try await store.localScenes(); precondition(cached.count == 1 && cached[0].id == scene.id)
        print("Native scene: complete hierarchy, joint units, playback parity, malformed manifests, resumable downloads and offline cache passed.")
    }
    static func navigation() {
        let landing = SIMD3<Float>(7, -12, 1.4), forward = simd_normalize(SIMD3<Float>(3, 4, 0))
        for yaw: Float in [-2.4, -0.5, 0, 1.2, 3.1] {
            for height: Float in [1.1, 1.6, 1.95] {
                var head = simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0)))
                head.columns.3 = SIMD4(2, height, -3, 1)
                var stage = simd_float4x4(VisionSceneNavigation.orientation(projectForward: forward, head: head))
                stage.columns.3 = SIMD4(VisionSceneNavigation.groundAnchor(head: head), 1)
                var offset = matrix_identity_float4x4; offset.columns.3 = SIMD4(-landing, 1)
                let world = stage * TeachingCoordinates.zUpToAR * offset
                let observer = (world.inverse * head.columns.3).xyz
                precondition(simd_distance(observer, landing + SIMD3(0, 0, height)) < 0.0001,
                             "Entry must place feet on the selected floor, preserving real eye height")
                let looking = (world * SIMD4(forward, 0)).xyz
                precondition(simd_distance(looking, -head.columns.2.xyz) < 0.0001,
                             "Entry must face the robot regardless of the headset's initial yaw")
                let moved = (world.inverse * (head.columns.3 + SIMD4<Float>(0.7, 0, -0.5, 0))).xyz
                precondition(abs(simd_distance(moved, observer) - sqrt(0.74)) < 0.0001,
                             "Head movement must stay one-to-one in metres")
            }
        }
        let low = SIMD3<Float>(-3, -2, -0.1), high = SIMD3<Float>(3, 2, 2)
        func accepted(_ point: SIMD3<Float>, _ normal: SIMD3<Float>) -> Bool {
            VisionSceneNavigation.standable(point: point, normal: normal, low: low, high: high)
        }
        precondition(accepted(.zero, SIMD3(0, 0, 1)))
        precondition(!accepted(.zero, SIMD3(1, 0, 0)), "Walls cannot be landing points")
        precondition(!accepted(.zero, SIMD3(0, 0, -1)), "Undersides cannot be landing points")
        precondition(!accepted(.zero, SIMD3(0.7, 0, 0.7)), "Steep slopes cannot be landing points")
        precondition(!accepted(SIMD3(7, 0, 0), SIMD3(0, 0, 1)))
        precondition(!accepted(SIMD3(.nan, 0, 0), SIMD3(0, 0, 1)))
        precondition(VisionSceneNavigation.entryCandidates(near: landing).allSatisfy {
            simd_distance($0, landing) > 0.65 && abs($0.z - landing.z) < 0.0001
        }, "Entry search must start outside the robot base on the same level")
        print("Navigation: floor validation, metre scale, entry heading and natural head movement passed.")
    }
}
