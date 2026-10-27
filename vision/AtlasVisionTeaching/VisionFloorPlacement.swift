import Foundation
import simd

// ARKit geometry is kept in world coordinates. Only classified floors are
// eligible; a low table must never become a floor merely because it is flat.
struct VisionFloorSurface {
    let id: UUID
    let transform: simd_float4x4
    let vertices: [SIMD3<Float>]
    let indices: [UInt32]
    let valid: Bool
    private let low: SIMD3<Float>
    private let high: SIMD3<Float>

    init(id: UUID, isFloor: Bool, transform: simd_float4x4,
         vertices: [SIMD3<Float>], indices: [UInt32]) {
        self.id = id; self.transform = transform
        self.vertices = vertices; self.indices = indices
        low = vertices.reduce(SIMD3(repeating: Float.infinity), simd_min)
        high = vertices.reduce(SIMD3(repeating: -Float.infinity), simd_max)
        let geometryValid = vertices.count >= 3 && indices.count >= 3 && indices.count.isMultiple(of: 3)
            && indices.allSatisfy { Int($0) < vertices.count }
            && vertices.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }
        var area: Float = 0
        if geometryValid {
            for i in stride(from: 0, to: indices.count, by: 3) {
                let a = vertices[Int(indices[i])], b = vertices[Int(indices[i + 1])], c = vertices[Int(indices[i + 2])]
                area += simd_length(simd_cross(b - a, c - a)) / 2
            }
        }
        valid = isFloor && VisionPoseMath.isRigid(transform) && abs(transform.columns.1.y) >= 0.98
            && geometryValid && area >= 0.25
    }

    func ground(below head: SIMD3<Float>) -> SIMD3<Float>? {
        guard valid, head.x.isFinite, head.y.isFinite, head.z.isFinite else { return nil }
        let normal = transform.columns.1.xyz, center = transform.translation
        let height = center.y - (normal.x * (head.x - center.x) + normal.z * (head.z - center.z)) / normal.y
        let drop = head.y - height
        let dx = max(low.x - head.x, head.x - high.x, 0), dz = max(low.z - head.z, head.z - high.z, 0)
        guard height.isFinite, drop >= 0.35, drop <= 3, dx * dx + dz * dz <= 9 else { return nil }
        return SIMD3(head.x, height, head.z)
    }

    func containsFoot(of head: SIMD3<Float>) -> Bool {
        guard ground(below: head) != nil else { return false }
        return VisionPoseMath.intersection(origin: head, direction: SIMD3(0, -1, 0), vertices: vertices, indices: indices) != nil
    }

    func placement(head: simd_float4x4) -> simd_float4x4? {
        guard VisionPoseMath.isRigid(head), let foot = ground(below: head.translation) else { return nil }
        var matrix = simd_float4x4(VisionSceneNavigation.orientation(projectForward: SIMD3(0, 1, 0), head: head))
        matrix.columns.3 = SIMD4(foot, 1)
        return matrix
    }
}

// Give discovery time to report other floors. Once ambiguity has appeared,
// require an intentional selection even if an anchor subsequently disappears.
struct VisionFloorPlacementDecision {
    private(set) var requiresConfirmation = false
    private var elapsed = 0.0, stable = 0.0
    private var candidate: UUID?
    private var height: Float?

    mutating func update(_ surfaces: [VisionFloorSurface], head: SIMD3<Float>, delta: Double) -> UUID? {
        elapsed += max(0, min(delta, 0.2))
        let candidates = surfaces.filter { $0.ground(below: head) != nil }
        if candidates.count > 1 { requiresConfirmation = true }
        guard candidates.count == 1, let floor = candidates.first, floor.containsFoot(of: head) else {
            candidate = nil; height = nil; stable = 0; return nil
        }
        let nextHeight = floor.ground(below: head)!.y
        if candidate != floor.id || height.map({ abs($0 - nextHeight) > 0.025 }) != false {
            candidate = floor.id; height = nextHeight; stable = 0
        } else { stable += max(0, min(delta, 0.2)) }
        return !requiresConfirmation && elapsed >= 2 && stable >= 1.2 ? floor.id : nil
    }
}
