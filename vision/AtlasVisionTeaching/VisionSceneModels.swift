import Foundation
import simd

struct VisionSceneAsset: Codable, Identifiable {
    let id: String
    let manifest: ModelManifest
    init(from decoder: Decoder) throws {
        id = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .id)
        manifest = try ModelManifest(from: decoder)
    }
    func encode(to encoder: Encoder) throws {
        try manifest.encode(to: encoder)
        var container = encoder.container(keyedBy: CodingKeys.self); try container.encode(id, forKey: .id)
    }
    private enum CodingKeys: String, CodingKey { case id }
}
struct VisionSceneJoint: Codable {
    let name: String; let type: String; let axis: [Float]
    let restPosition: [Float]; let restQuaternion: [Float]; let value: Float
    func matrix(value: Float) -> simd_float4x4 {
        let axis = SIMD3(axis), rest = simd_quatf(vector: SIMD4(restQuaternion))
        let rotation = type == "prismatic" ? rest : rest * simd_quatf(angle: value * .pi / 180, axis: axis)
        let position = SIMD3(restPosition) + (type == "prismatic" ? axis * value : .zero)
        var result = simd_float4x4(rotation); result.columns.3 = SIMD4(position, 1); return result
    }
}
struct VisionSceneMaterial: Codable {
    let roughness: Float
    let metallic: Float
    // Matches the URDF material used by the Web robot loader. Older cached
    // scenes lack material metadata but should also regain surface shading.
    static let robotDefault = VisionSceneMaterial(roughness: 0.58, metallic: 0.16)
}
struct VisionSceneNode: Codable, Identifiable {
    let id: String; let name: String; let role: String; let parent: String?
    let transform: [Float]; let asset: String?; let joint: VisionSceneJoint?
    let material: VisionSceneMaterial?
}
enum VisionSceneCameraSide: String, CaseIterable, Identifiable {
    case left, right
    var id: String { rawValue }
    var title: String { self == .left ? "左相机" : "右相机" }
    var opticalFrameName: String { "zivid_\(rawValue)_optical_frame" }
}

/// All transforms stay in project metres, independent of the observer and sandbox.
struct VisionSceneCameraSnapshot: Equatable {
    var transforms: [String: simd_float4x4]
    func cameraTransform(_ nodeID: String) -> simd_float4x4? {
        transforms[nodeID].map { $0 * TeachingCoordinates.opticalToARCamera }
    }
}
struct VisionScenePath: Codable, Identifiable { let id: String; let name: String; let points: [[Float]] }
struct VisionSceneMarker: Codable, Identifiable {
    let id: String; let name: String; let kind: String; let position: [Float]; let taskId: String?
}
struct VisionSceneRPY: Codable { var roll: Float; var pitch: Float; var yaw: Float }
struct VisionScenePose: Codable {
    var position: Point3; var rpy: VisionSceneRPY
    var matrix: simd_float4x4 {
        let d = Float.pi / 180
        let q = simd_quatf(angle: rpy.yaw * d, axis: SIMD3(0, 0, 1))
            * simd_quatf(angle: rpy.pitch * d, axis: SIMD3(0, 1, 0))
            * simd_quatf(angle: rpy.roll * d, axis: SIMD3(1, 0, 0))
        var m = simd_float4x4(q); m.columns.3 = SIMD4(position.simd, 1); return m
    }
}
struct VisionSceneSegment: Codable {
    let phase: String; let durationMs: Double; let startOffsetMs: Double; let endOffsetMs: Double
    let fromPose: VisionScenePose; let toPose: VisionScenePose
    let fromJointValues: [String: Float]; let toJointValues: [String: Float]
}
struct VisionSceneClip: Codable, Identifiable {
    let taskId: String; let taskName: String; let totalDurationMs: Double
    let initialRobotPose: VisionScenePose; let initialJointValues: [String: Float]
    let segments: [VisionSceneSegment]
    var id: String { taskId }
    func sample(milliseconds: Double) -> (VisionScenePose, [String: Float]) {
        guard let segment = segments.first(where: { milliseconds < $0.endOffsetMs }) ?? segments.last else { return (initialRobotPose, initialJointValues) }
        let t = Float(min(1, max(0, (milliseconds - segment.startOffsetMs) / max(0.001, segment.durationMs))))
        let eased = t * t * t * (10 + t * (-15 + t * 6))
        var pose = segment.toPose, joints = segment.toJointValues
        if segment.phase == "chassis" {
            pose.position = Point3(simd_mix(segment.fromPose.position.simd, segment.toPose.position.simd, SIMD3(repeating: eased)))
            func angle(_ a: Float, _ b: Float) -> Float {
                var delta = (b - a).truncatingRemainder(dividingBy: 360)
                if delta >= 180 { delta -= 360 }; if delta < -180 { delta += 360 }
                return a + delta * eased
            }
            pose.rpy = VisionSceneRPY(roll: angle(segment.fromPose.rpy.roll, pose.rpy.roll),
                pitch: angle(segment.fromPose.rpy.pitch, pose.rpy.pitch), yaw: angle(segment.fromPose.rpy.yaw, pose.rpy.yaw))
        }
        if segment.phase == "joints" {
            for key in Set(segment.fromJointValues.keys).union(segment.toJointValues.keys) {
                let a = segment.fromJointValues[key] ?? 0, b = segment.toJointValues[key] ?? a
                joints[key] = a + (b - a) * eased
            }
        }
        return (pose, joints)
    }
}
struct VisionSceneBounds: Codable { let min: [Float]; let max: [Float] }
struct VisionSceneManifest: Codable, Identifiable {
    let id: String; let format: String; let name: String; let coordinateFrame: String; let createdAt: String
    let bounds: VisionSceneBounds; let assets: [VisionSceneAsset]; let nodes: [VisionSceneNode]
    let robotRoot: String?; let paths: [VisionScenePath]; let markers: [VisionSceneMarker]; let clips: [VisionSceneClip]
    var cameraNodes: [VisionSceneCameraSide: String] {
        Dictionary(uniqueKeysWithValues: VisionSceneCameraSide.allCases.compactMap { side in
            nodes.first(where: { $0.name == side.opticalFrameName }).map { (side, $0.id) }
        })
    }
    var hasPointCloudMap: Bool {
        let mapAssets = Set(nodes.filter { $0.role == "map" }.compactMap(\.asset))
        return assets.contains { mapAssets.contains($0.id) && $0.manifest.indices == 0 }
    }
    // Navigation/parking points locate the traversable surface. A raised robot
    // base or a captured camera pose must not lift a solid floor over the routes.
    var navigationGroundHeight: Float? {
        markers.filter { $0.kind == "parking" }.map { $0.position[2] }.min()
    }
    func validate() throws {
        func vector(_ v: [Float], _ count: Int) -> Bool { v.count == count && v.allSatisfy(\.isFinite) }
        func name(_ v: String) -> Bool { !v.isEmpty && v.count <= 512 }
        guard UUID(uuidString: id) != nil, format == "atlas-vision-scene/1", ["map", "virtual_origin"].contains(coordinateFrame),
              name(self.name),
              vector(bounds.min, 3), vector(bounds.max, 3), zip(bounds.min, bounds.max).allSatisfy({ $0 <= $1 }),
              !assets.isEmpty, assets.count <= 1024, nodes.count <= 8192, paths.count <= 50000, markers.count <= 50000,
              clips.count <= 512 else { throw TeachingError("空间工程格式或规模无效") }
        var assetIDs = Set<String>(), nodeIDs = Set<String>(), bytes = 0
        for asset in assets {
            guard asset.id.count == 64, asset.id.allSatisfy({ $0.isHexDigit && !$0.isUppercase }), asset.id == asset.manifest.modelHash,
                  assetIDs.insert(asset.id).inserted, asset.manifest.byteLength > 0, asset.manifest.byteLength <= maximumModelBytes else { throw TeachingError("空间资源清单无效") }
            let m = asset.manifest
            guard m.protocol == teachingProtocol, m.coordinateFrame == "virtual_origin", m.verticalAxis == "Z", m.distanceUnit == "meter",
                  m.vertices > 0, m.vertices <= maximumModelVertices, m.indices >= 0, m.indices <= maximumModelIndices, m.indices % 3 == 0,
                  m.byteLength == 32 + m.vertices * 16 + m.indices * 4, let b = m.bounds,
                  (0..<3).allSatisfy({ b.min.simd[$0].isFinite && b.max.simd[$0].isFinite && b.min.simd[$0] <= b.max.simd[$0] }) else { throw TeachingError("空间资源坐标或边界无效") }
            bytes += asset.manifest.byteLength
        }
        guard bytes <= 1024 * 1024 * 1024 else { throw TeachingError("空间工程超过 1 GiB") }
        for node in nodes {
            guard name(node.id), name(node.name), ["map", "robot", "part", "joint"].contains(node.role), !nodeIDs.contains(node.id), node.parent.map({ nodeIDs.contains($0) }) ?? true,
                  vector(node.transform, 16), node.asset.map({ assetIDs.contains($0) }) ?? true else { throw TeachingError("空间层级无效") }
            let m = node.transform
            if let material = node.material {
                guard node.role == "part", [material.roughness, material.metallic].allSatisfy({ $0.isFinite && (0...1).contains($0) }) else {
                    throw TeachingError("机器人表面材质无效")
                }
            }
            guard [3, 7, 11].allSatisfy({ abs(m[$0]) < 0.0001 }), abs(m[15] - 1) < 0.0001,
                  [0, 4, 8].allSatisfy({ simd_length(SIMD3(m[$0], m[$0 + 1], m[$0 + 2])) > 1e-8 }) else { throw TeachingError("空间节点变换无效") }
            if let joint = node.joint {
                guard name(joint.name), ["revolute", "continuous", "prismatic"].contains(joint.type), vector(joint.axis, 3),
                      abs(simd_length(SIMD3(joint.axis)) - 1) < 0.002, vector(joint.restPosition, 3), vector(joint.restQuaternion, 4),
                      abs(simd_length(SIMD4(joint.restQuaternion)) - 1) < 0.002, joint.value.isFinite else { throw TeachingError("空间关节无效") }
            }
            nodeIDs.insert(node.id)
        }
        guard robotRoot.map({ nodeIDs.contains($0) }) ?? true,
              paths.allSatisfy({ name($0.id) && name($0.name) && $0.points.count <= 50000 && $0.points.allSatisfy { vector($0, 3) } }),
              paths.reduce(0, { $0 + $1.points.count }) <= 200000, Set(paths.map(\.id)).count == paths.count,
              markers.allSatisfy({ name($0.id) && name($0.name) && vector($0.position, 3) }), Set(markers.map(\.id)).count == markers.count,
              Set(clips.map(\.id)).count == clips.count, clips.reduce(0, { $0 + $1.segments.count }) <= 50000 else { throw TeachingError("空间路线无效") }
        func validPose(_ p: VisionScenePose) -> Bool { VisionPoseMath.isRigid(p.matrix) }
        func joints(_ values: [String: Float]) -> Bool { values.count <= 256 && values.allSatisfy { name($0.key) && $0.value.isFinite } }
        for clip in clips {
            guard name(clip.taskId), name(clip.taskName), clip.totalDurationMs.isFinite, clip.totalDurationMs > 0, validPose(clip.initialRobotPose),
                  joints(clip.initialJointValues) else { throw TeachingError("空间回放无效") }
            var time = 0.0
            for segment in clip.segments {
                guard ["chassis", "joints", "hold"].contains(segment.phase), segment.durationMs.isFinite, segment.durationMs >= 0,
                      abs(segment.startOffsetMs - time) < 0.001, abs(segment.endOffsetMs - time - segment.durationMs) < 0.001,
                      validPose(segment.fromPose), validPose(segment.toPose), joints(segment.fromJointValues),
                      joints(segment.toJointValues) else { throw TeachingError("空间回放分段无效") }
                time = segment.endOffsetMs
            }
            guard abs(time - clip.totalDurationMs) < 0.001 else { throw TeachingError("空间回放时长不一致") }
        }
    }
}
struct VisionSceneOffer: Decodable, Identifiable {
    let id: String; let name: String; let readToken: String; let bytes: Int; let hasRobot: Bool; let clipCount: Int
}

extension SIMD3 where Scalar == Float { init(_ values: [Float]) { self.init(values[0], values[1], values[2]) } }
extension SIMD4 where Scalar == Float { init(_ values: [Float]) { self.init(values[0], values[1], values[2], values[3]) } }
