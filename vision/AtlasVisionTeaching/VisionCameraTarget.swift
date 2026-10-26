import Foundation
import simd

/// An authored camera in the original, metre-based model frame. Its optical
/// axes are +X right, +Y down, +Z forward, independently of the viewer's head.
struct VisionCameraTarget {
    static let frameName = "visionpro_virtual_camera_optical_frame"
    var transform: simd_float4x4
    var focus: SIMD3<Float>?
    var focusLocked: Bool

    var position: SIMD3<Float> { transform.columns.3.xyz }
    var distance: Float? { focus.map { simd_distance(position, $0) } }
    var draft: SpatialCameraDraft {
        SpatialCameraDraft(cameraPose: CameraPose(frameName: Self.frameName,
            position: Point3(position), quaternion: Rotation4(simd_quatf(transform))),
            surfacePoint: focus.map(Point3.init), keepFocus: focusLocked)
    }

    init(transform: simd_float4x4, focus: SIMD3<Float>? = nil, focusLocked: Bool = true) throws {
        guard VisionPoseMath.isRigid(transform), focus.map(Self.finite) ?? true else {
            throw TeachingError("相机位置无效，请重新放置相机")
        }
        self.transform = transform; self.focus = focus
        self.focusLocked = focus != nil && focusLocked
    }

    init(draft: SpatialCameraDraft) throws {
        let p = draft.cameraPose
        let q = SIMD4(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w)
        guard (0..<4).allSatisfy({ q[$0].isFinite }), abs(simd_length(q) - 1) < 0.002 else {
            throw TeachingError("相机方向无效")
        }
        var matrix = simd_float4x4(simd_quatf(vector: q).normalized)
        matrix.columns.3 = SIMD4(p.position.simd, 1)
        try self.init(transform: matrix, focus: draft.surfacePoint?.simd, focusLocked: draft.keepFocus ?? true)
    }

    static func finite(_ point: SIMD3<Float>) -> Bool { (0..<3).allSatisfy { point[$0].isFinite } }

    func aiming(at point: SIMD3<Float>) throws -> Self {
        guard Self.finite(point), simd_distance(position, point) > 0.02 else {
            throw TeachingError("请选取离相机更远的工件表面")
        }
        let forward = simd_normalize(point - position)
        // Model +Z is upright. Near a pole, retain the previous camera up axis
        // instead of introducing an unstable roll or a singular look-at matrix.
        var up = SIMD3<Float>(0, 0, 1)
        if abs(simd_dot(forward, up)) > 0.98 { up = -transform.columns.1.xyz }
        if abs(simd_dot(forward, up)) > 0.98 { up = SIMD3(0, 1, 0) }
        let right = simd_normalize(simd_cross(forward, up))
        let down = simd_normalize(simd_cross(forward, right))
        let matrix = simd_float4x4(columns: (SIMD4(right, 0), SIMD4(down, 0), SIMD4(forward, 0), SIMD4(position, 1)))
        return try Self(transform: matrix, focus: point)
    }

    func moving(to position: SIMD3<Float>, keepFocus: Bool) throws -> Self {
        var matrix = transform; matrix.columns.3 = SIMD4(position, 1)
        let moved = try Self(transform: matrix, focus: focus, focusLocked: keepFocus)
        return try keepFocus && focus != nil ? moved.aiming(at: focus!) : moved
    }

    func atDistance(_ distance: Float) throws -> Self {
        guard let focus, distance.isFinite, (0.3...1.3).contains(distance),
              simd_distance(position, focus) > 0.02 else { throw TeachingError("先点选工件上的拍摄位置") }
        return try moving(to: focus + simd_normalize(position - focus) * distance, keepFocus: true)
    }

    func sample(segmentID: String) throws -> TeachingSample {
        guard !segmentID.isEmpty, VisionPoseMath.isRigid(transform) else { throw TeachingError("请先放置工件") }
        return TeachingSample(segmentId: segmentID, kind: "keyframe", cameraPose: draft.cameraPose,
            surfacePoint: draft.surfacePoint,
            previewCameraTransform: (transform * TeachingCoordinates.opticalToARCamera).elements)
    }
}

/// One undo entry per completed gesture, not per tracking update.
struct VisionTargetHistory {
    private(set) var entries: [VisionCameraTarget] = []
    mutating func push(_ target: VisionCameraTarget?) {
        guard let target else { return }
        entries.append(target)
        if entries.count > 40 { entries.removeFirst() }
    }
    mutating func pop() -> VisionCameraTarget? { entries.popLast() }
    mutating func clear() { entries.removeAll() }
}
