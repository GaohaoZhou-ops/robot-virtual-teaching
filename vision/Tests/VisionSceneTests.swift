import Foundation
import simd

@main struct VisionSceneTests {
    struct Expected: Decodable {
        let milliseconds: Double; let pose: VisionScenePose; let joints: [String: Float]; let tip: [Float]
        let cameras: [String: [Float]]
    }
    static func close(_ a: simd_float4x4, _ b: simd_float4x4) {
        for (a, b) in zip(a.elements, b.elements) { precondition(abs(a - b) < 0.0002, "Native robot transform differs from desktop") }
    }
    static func main() async throws {
        navigation()
        let base = CommandLine.arguments[1], directory = URL(fileURLWithPath: CommandLine.arguments[2])
        let decoder = JSONDecoder(), data = try Data(contentsOf: directory.appendingPathComponent("scene.json"))
        let scene = try decoder.decode(VisionSceneManifest.self, from: data); try scene.validate()
        precondition(scene.cameraNodes.count == 2, "Both optical frames survive project export")
        precondition(scene.hasPointCloudMap, "A mixed map still needs a continuous navigation reference floor")
        var meshOnly = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        let pointAssets = Set(scene.assets.filter { $0.manifest.indices == 0 }.map(\.id))
        meshOnly["nodes"] = (meshOnly["nodes"] as! [[String: Any]]).map { node in
            var node = node
            if let asset = node["asset"] as? String, pointAssets.contains(asset) { node["role"] = "part" }
            return node
        }
        let meshOnlyScene = try decoder.decode(VisionSceneManifest.self, from: JSONSerialization.data(withJSONObject: meshOnly))
        precondition(!meshOnlyScene.hasPointCloudMap, "Non-map point assets must not change map navigation")
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
            let snapshot = VisionSceneCameraSnapshot(transforms: world)
            for side in VisionSceneCameraSide.allCases {
                let optical = simd_float4x4(elements: sample.cameras[side.rawValue]!)
                close(snapshot.cameraTransform(scene.cameraNodes[side]!)!, optical * TeachingCoordinates.opticalToARCamera)
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
        let mapAssets = Set(scene.nodes.filter { $0.role == "map" }.compactMap(\.asset))
        var renderedMapPoints = 0
        for asset in scene.assets where mapAssets.contains(asset.id) && asset.manifest.indices == 0 {
            let model = try await store.model(asset)
            let rendered = try VisionMeshData(model: model, mode: .points, quality: .full)
            precondition(!rendered.isMesh && rendered.primitiveCount == model.vertices)
            precondition(rendered.positions.count == model.vertices * 4 && rendered.triangles.count == model.vertices * 12)
            renderedMapPoints += rendered.primitiveCount
        }
        precondition(renderedMapPoints == 3, "All loose map points reach native rendering beside the mesh and robot")
        try await VisionSceneCameraTests.run(scene, store: store)
        _ = try await store.download(offers[0], address: base) { _ in }
        let broken = directory.appendingPathComponent("device/\(scene.assets[0].id).atls")
        try Data([0, 1, 2]).write(to: broken)
        _ = try await store.download(offers[0], address: base) { _ in }
        let cached = try await store.localScenes(); precondition(cached.count == 1 && cached[0].id == scene.id)
        print("Native scene: mixed-map point rendering and navigation, complete hierarchy, joint units, playback parity, malformed manifests, resumable downloads and offline cache passed.")
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
