import Foundation
import simd

// All destinations are in the project's original Z-up metre coordinates.
// Moving the world around the tracked head preserves natural 1:1 head motion;
// neither the robot's base nor any project geometry is edited by locomotion.
enum VisionSceneNavigation {
    static let up = SIMD3<Float>(0, 0, 1)
    static func horizontal(_ value: SIMD3<Float>, fallback: SIMD3<Float> = SIMD3(0, 1, 0)) -> SIMD3<Float> {
        let flat = SIMD3(value.x, value.y, 0)
        return simd_length(flat) > 0.001 ? simd_normalize(flat) : fallback
    }
    static func orientation(projectForward: SIMD3<Float>, head: simd_float4x4) -> simd_quatf {
        let source = horizontal(projectForward)
        let arSource = SIMD3(source.x, 0, -source.y)
        let view = -head.columns.2.xyz
        let flat = SIMD3(view.x, 0, view.z)
        let target = simd_length(flat) > 0.001 ? simd_normalize(flat) : SIMD3<Float>(0, 0, -1)
        let angle = atan2(simd_cross(arSource, target).y, simd_dot(arSource, target))
        return simd_quatf(angle: angle, axis: SIMD3(0, 1, 0))
    }
    static func groundAnchor(head: simd_float4x4) -> SIMD3<Float> { SIMD3(head.columns.3.x, 0, head.columns.3.z) }
    static func standable(point: SIMD3<Float>, normal: SIMD3<Float>, low: SIMD3<Float>, high: SIMD3<Float>) -> Bool {
        [point.x, point.y, point.z, normal.x, normal.y, normal.z].allSatisfy(\.isFinite)
            && point.x >= low.x - 0.05 && point.x <= high.x + 0.05
            && point.y >= low.y - 0.05 && point.y <= high.y + 0.05
            && point.z >= low.z - 0.3 && point.z <= high.z + 0.3
            && normal.z >= 0.82 // approximately 35 degrees, upward-facing only
    }
    static func entryCandidates(near point: SIMD3<Float>) -> [SIMD3<Float>] {
        // Start beside the robot, not in its base. Try several directions and
        // radii so imported robots near a wall still have a usable entry.
        [Float(1.8), 1.2, 2.6, 0.7].flatMap { radius in
            (0..<8).map { step in
                let a = Float(step) * .pi / 4
                return point + SIMD3(sin(a) * radius, -cos(a) * radius, 0)
            }
        }
    }
}
