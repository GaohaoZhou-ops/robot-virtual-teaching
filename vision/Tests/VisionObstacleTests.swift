import Foundation
import simd

enum VisionObstacleTests {
    static func run() {
        func head(_ position: SIMD3<Float> = SIMD3(0, 1.6, 0), yaw: Float = 0) -> simd_float4x4 {
            var matrix = simd_float4x4(simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0)))
            matrix.columns.3 = SIMD4(position, 1); return matrix
        }
        func wall(_ z: Float, x: Float = 0) -> VisionObstacleMesh {
            VisionObstacleMesh(vertices: [SIMD3(x - 4, -1, z), SIMD3(x + 4, -1, z), SIMD3(x + 4, 4, z), SIMD3(x - 4, 4, z)],
                               indices: [0, 1, 2, 0, 2, 3])!
        }
        func horizontal(_ y: Float, front: Float = -1, back: Float = -3, classifiedFloor: Bool = false) -> VisionObstacleMesh {
            VisionObstacleMesh(vertices: [SIMD3(-2, y, front), SIMD3(2, y, front), SIMD3(2, y, back), SIMD3(-2, y, back)],
                               indices: [0, 1, 2, 0, 2, 3], floorFaces: classifiedFloor ? [0, 1] : [])!
        }
        func distance(_ sample: VisionObstacleSample, _ expected: Float) {
            guard case .obstacle(let actual) = sample else { preconditionFailure("Expected obstacle at \(expected), got \(sample)") }
            precondition(abs(actual - expected) < 0.001, "Expected \(expected), got \(actual)")
        }
        let id = UUID()
        var field = VisionObstacleField()
        precondition(field.sample(head: head(), floor: 0) == .unavailable, "No mesh data must not be treated as clear space")
        field.meshes[id] = wall(-1.5)
        distance(field.sample(head: head(), floor: 0), 1.5)
        distance(field.sample(head: head(SIMD3(0, 1.6, -0.5)), floor: 0), 1)
        field.meshes[id] = wall(-2.4)
        distance(field.sample(head: head(), floor: 0), 2.4)
        field.meshes[id] = wall(1)
        precondition(field.sample(head: head(), floor: 0) == .clear, "A wall behind the wearer must not trigger forward fading")
        distance(field.sample(head: head(yaw: .pi), floor: 0), 1)
        field.meshes[id] = wall(-1, x: 9)
        precondition(field.sample(head: head(), floor: 0) == .unavailable, "Far-away anchors do not establish local coverage")
        field.meshes[id] = horizontal(0)
        precondition(field.sample(head: head(), floor: 0) == .clear, "A flat floor is not an obstacle")
        field.meshes[id] = horizontal(0.3, classifiedFloor: true)
        precondition(field.sample(head: head(), floor: 0) == .clear, "Classified floor faces are excluded")
        field.meshes[id] = horizontal(0.8)
        distance(field.sample(head: head(), floor: 0), 1)
        field.meshes[id] = horizontal(0.8, front: 1)
        distance(field.sample(head: head(), floor: 0), 0)
        field.meshes[id] = horizontal(3)
        precondition(field.sample(head: head(), floor: 0) == .clear, "A high ceiling is outside the body-height band")
        // Side walls can cross the edge of the wide forward sector; tabletop
        // and thin furniture geometry must not depend on a single eye-height ray.
        field.meshes[id] = VisionObstacleMesh(vertices: [SIMD3(1, 0, -4), SIMD3(1, 3, -4), SIMD3(1, 3, 4), SIMD3(1, 0, 4)], indices: [0, 1, 2, 0, 2, 3])!
        guard case .obstacle(let side) = field.sample(head: head(), floor: 0) else { preconditionFailure() }
        precondition(side >= 1 && side < 1.2)
        field.meshes[id] = VisionObstacleMesh(vertices: [SIMD3(-0.02, 0.2, -1.2), SIMD3(0.02, 0.2, -1.2), SIMD3(0, 1, -1.2)], indices: [0, 1, 2])!
        distance(field.sample(head: head(), floor: 0), 1.2)
        field.meshes.removeValue(forKey: id)
        precondition(field.sample(head: head(), floor: 0) == .unavailable, "Removed anchors cannot leave phantom obstacles")
        // Translate the real room and floor together; project origins, scales
        // and teleport offsets never enter this computation.
        field.meshes[id] = horizontal(4.8)
        distance(field.sample(head: head(SIMD3(0, 5.6, 0)), floor: 4), 1)
        field.meshes[id] = horizontal(4)
        precondition(field.sample(head: head(SIMD3(0, 5.6, 0)), floor: 4) == .clear)
        precondition(field.sample(head: head(SIMD3(.nan, 1.6, 0)), floor: 0) == .unavailable)
        precondition(VisionObstacleMesh(vertices: [.zero], indices: [0, 1, 2]) == nil)
        precondition(VisionObstacleTriangle(.zero, .zero, .zero) == nil)

        precondition(VisionObstacleFade.target(distance: 2) == 0)
        precondition(VisionObstacleFade.target(distance: 1.5) == 0.5)
        precondition(VisionObstacleFade.target(distance: 1) == 1)
        precondition(VisionObstacleFade.target(distance: 0.5) == 1)
        precondition(VisionObstacleFade.target(distance: .nan) == 1)
        var fade = VisionObstacleFade()
        for _ in 0..<360 { fade.update(.clear, delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.amount == 0 && !fade.needsPassthrough)
        fade.update(.obstacle(2.1), delta: 0.1, passthroughVisible: false)
        precondition(fade.needsPassthrough && fade.amount == 0, "Request mixed mode before starting the visible fade")
        for _ in 0..<60 { fade.update(.obstacle(1.5), delta: 1.0 / 60, passthroughVisible: false) }
        precondition(fade.amount == 0, "Never fade onto full immersion's black background")
        fade.update(.obstacle(1.5), delta: 1.0 / 60, passthroughVisible: true)
        precondition(fade.amount > 0 && fade.amount < 0.5, "Passthrough confirmation starts a gradual fade")
        for _ in 0..<90 { fade.update(.obstacle(1.5), delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.amount == 0.5)
        for _ in 0..<60 { fade.update(.obstacle(1), delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.amount == 1)
        for i in 0..<300 { fade.update(.obstacle(i.isMultiple(of: 2) ? 2.05 : 2.29), delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.amount == 0 && fade.needsPassthrough, "Threshold jitter must not toggle immersion styles")
        for _ in 0..<30 { fade.update(.clear, delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.needsPassthrough)
        for _ in 0..<60 { fade.update(.clear, delta: 1.0 / 60, passthroughVisible: true) }
        precondition(!fade.needsPassthrough)
        fade.update(.unavailable, delta: 1.0 / 60, passthroughVisible: false)
        precondition(fade.needsPassthrough && fade.amount == 0)
        for _ in 0..<60 { fade.update(.unavailable, delta: 1.0 / 60, passthroughVisible: true) }
        precondition(fade.amount == 1, "Lost sensors or permission must reveal surroundings")
        var at30 = VisionObstacleFade(), at90 = VisionObstacleFade()
        for _ in 0..<30 { at30.update(.obstacle(1.5), delta: 1.0 / 30, passthroughVisible: true) }
        for _ in 0..<90 { at90.update(.obstacle(1.5), delta: 1.0 / 90, passthroughVisible: true) }
        precondition(abs(at30.amount - at90.amount) < 0.0001, "Animation must be frame-rate independent")
        print("Obstacle proximity: physical mesh faces, forward/body coverage, floors, tables, removals, 2–1 m fade, passthrough sequencing, hysteresis and sensor-loss recovery passed.")
    }
}
