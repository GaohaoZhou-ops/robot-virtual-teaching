import Foundation
import simd

enum VisionFloorPlacementTests {
    static func run() {
        func surface(_ height: Float = 0, id: UUID = UUID(), floor: Bool = true,
                     x: Float = 0, angle: Float = 0, triangles: [UInt32] = [0, 2, 1, 0, 3, 2]) -> VisionFloorSurface {
            var transform = simd_float4x4(simd_quatf(angle: angle, axis: SIMD3(1, 0, 0)))
            transform.columns.3 = SIMD4(x, height, 0, 1)
            let vertices: [SIMD3<Float>] = [SIMD3(-4, 0, -4), SIMD3(4, 0, -4), SIMD3(4, 0, 4), SIMD3(-4, 0, 4)]
            return VisionFloorSurface(id: id, isFloor: floor, transform: transform,
                vertices: vertices.map { (transform * SIMD4($0, 1)).xyz }, indices: triangles)
        }
        let floor = surface(0.3), table = surface(0.9, floor: false), headPoint = SIMD3<Float>(1, 1.9, -2)
        precondition(floor.containsFoot(of: headPoint))
        precondition(table.ground(below: headPoint) == nil, "Flat tables are never floor candidates")
        precondition(surface(0.3, angle: .pi / 4).ground(below: headPoint) == nil)
        precondition(surface(2.2).ground(below: headPoint) == nil, "Surfaces above the head are not floors")
        precondition(surface(x: 30).ground(below: headPoint) == nil, "A distant floor is not a local candidate")
        precondition(!surface(triangles: [0, 1, 500]).valid)
        precondition(!surface(triangles: [0, 0, 0]).valid)
        precondition(surface(.nan).ground(below: headPoint) == nil)

        // Measured floor elevation, the current X/Z and heading all matter.
        // Project geometry keeps its original origin, scale and relative poses.
        for yaw: Float in [-2, 0, 1.4] {
            var head = simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0)))
            head.columns.3 = SIMD4(headPoint, 1)
            let stage = floor.placement(head: head)!, world = stage * TeachingCoordinates.zUpToAR
            precondition(simd_distance(world.translation, SIMD3(1, 0.3, -2)) < 0.0001)
            let observer = (world.inverse * head.columns.3).xyz
            precondition(simd_distance(observer, SIMD3(0, 0, 1.6)) < 0.0001)
            precondition(simd_distance((world * SIMD4<Float>(0, 1, 0, 0)).xyz, -head.columns.2.xyz) < 0.0001)
            let a = SIMD4<Float>(4, -2, 0.4, 1), b = SIMD4<Float>(1, 7, 2, 1)
            precondition(abs(simd_distance((world * a).xyz, (world * b).xyz) - simd_distance(a.xyz, b.xyz)) < 0.0001)
            let moved = (world.inverse * (head.columns.3 + SIMD4<Float>(0.6, 0, 0.8, 0))).xyz
            precondition(abs(simd_distance(observer, moved) - 1) < 0.0001, "The scene does not follow the moving head")
            precondition(VisionSceneNavigation.groundAnchor(head: head, floorHeight: 0.3) == SIMD3(1, 0.3, -2))
        }

        var unique = VisionFloorPlacementDecision(), selected: UUID?
        for _ in 0..<19 { precondition(unique.update([floor, table], head: headPoint, delta: 0.1) == nil) }
        for _ in 0..<10 { selected = unique.update([floor, table], head: headPoint, delta: 0.1) ?? selected }
        precondition(selected == floor.id, "Only a stable unique floor can be placed automatically")

        var ambiguous = VisionFloorPlacementDecision()
        for _ in 0..<10 { _ = ambiguous.update([floor], head: headPoint, delta: 0.1) }
        let second = surface(0.55)
        for _ in 0..<60 { precondition(ambiguous.update([floor, second], head: headPoint, delta: 0.1) == nil) }
        precondition(ambiguous.requiresConfirmation)
        for _ in 0..<40 { precondition(ambiguous.update([floor], head: headPoint, delta: 0.1) == nil,
            "An ambiguous choice must not commit silently when one plane disappears") }
        var empty = VisionFloorPlacementDecision()
        for _ in 0..<100 { precondition(empty.update([table], head: headPoint, delta: 0.1) == nil) }

        // A floor patch's bounding box must not stand in for its observed mesh.
        let triangle = surface(0.3, triangles: [0, 2, 1]), outside = SIMD3<Float>(-3, 1.9, 3)
        precondition(triangle.ground(below: outside) != nil && !triangle.containsFoot(of: outside))
        var offPatch = VisionFloorPlacementDecision()
        for _ in 0..<40 { precondition(offPatch.update([triangle], head: outside, delta: 0.1) == nil) }

        var unstable = VisionFloorPlacementDecision()
        for i in 0..<40 {
            let changing = surface(i.isMultiple(of: 2) ? 0.3 : 0.4, id: floor.id)
            precondition(unstable.update([changing], head: headPoint, delta: 0.1) == nil)
        }
        print("Floor placement: classified floors only, measured height/current origin, 1:1 motion, discovery stability, ambiguity and footprint checks passed.")
    }
}
