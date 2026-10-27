import Foundation
import simd

enum VisionObstacleSample: Equatable, Sendable {
    case unavailable
    case clear
    case obstacle(Float)
}

// Distances are physical world metres, independent of the project's transform.
struct VisionObstacleTriangle: Sendable {
    let a: SIMD3<Float>, b: SIMD3<Float>, c: SIMD3<Float>
    let low: SIMD3<Float>, high: SIMD3<Float>

    init?(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>) {
        guard [a, b, c].allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }),
              simd_length_squared(simd_cross(b - a, c - a)) > 1e-10 else { return nil }
        self.a = a; self.b = b; self.c = c
        low = simd_min(a, simd_min(b, c)); high = simd_max(a, simd_max(b, c))
    }

    func distance(head: SIMD3<Float>, forward: SIMD3<Float>, floor: Float, limit: Float) -> Float? {
        guard high.y > floor + 0.12, low.y < head.y + 0.25,
              Self.horizontalDistance(head, low: low, high: high) <= limit else { return nil }
        let right = SIMD3(-forward.z, 0, forward.x)
        // Clip entire faces, not just vertices: a large wall can span the whole
        // view even when all three vertices lie outside the detection region.
        var polygon = [a, b, c]
        polygon = Self.clip(polygon, normal: SIMD3(0, 1, 0), offset: -(floor + 0.12))
        polygon = Self.clip(polygon, normal: SIMD3(0, -1, 0), offset: head.y + 0.25)
        // A 120-degree forward region with 30 cm shoulder allowance. A small
        // overlap behind the head avoids missing the edge of a nearby object.
        polygon = Self.clip(polygon, normal: forward, offset: -simd_dot(forward, head) + 0.15)
        for sign: Float in [-1, 1] {
            let normal = forward * sqrt(3) + right * sign
            polygon = Self.clip(polygon, normal: normal, offset: -simd_dot(normal, head) + 0.30)
        }
        guard !polygon.isEmpty else { return nil }
        let points = polygon.map { SIMD2($0.x - head.x, $0.z - head.z) }
        var distance = Float.infinity, positive = false, negative = false
        for i in points.indices {
            let a = points[i], b = points[(i + 1) % points.count], edge = b - a
            let t = max(0, min(1, -simd_dot(a, edge) / max(1e-12, simd_length_squared(edge))))
            distance = min(distance, simd_length(a + edge * t))
            let cross = a.x * b.y - a.y * b.x
            positive = positive || cross > 1e-6; negative = negative || cross < -1e-6
        }
        // A horizontal face can cover the observer's projection. Degenerate
        // projected polygons (vertical walls) still use segment distance.
        if positive != negative { distance = 0 }
        return distance <= limit ? distance : nil
    }

    static func horizontalDistance(_ p: SIMD3<Float>, low: SIMD3<Float>, high: SIMD3<Float>) -> Float {
        let d = simd_max(simd_max(low - p, p - high), .zero)
        return simd_length(SIMD2(d.x, d.z))
    }

    private static func clip(_ polygon: [SIMD3<Float>], normal: SIMD3<Float>, offset: Float) -> [SIMD3<Float>] {
        guard var previous = polygon.last else { return [] }
        var result: [SIMD3<Float>] = [], previousDistance = simd_dot(normal, previous) + offset
        for point in polygon {
            let distance = simd_dot(normal, point) + offset
            if (distance >= 0) != (previousDistance >= 0) {
                result.append(previous + (point - previous) * (previousDistance / (previousDistance - distance)))
            }
            if distance >= 0 { result.append(point) }
            previous = point; previousDistance = distance
        }
        return result
    }
}

struct VisionObstacleMesh: Sendable {
    let triangles: [VisionObstacleTriangle]
    let low: SIMD3<Float>, high: SIMD3<Float>

    init?(vertices: [SIMD3<Float>], indices: [UInt32], floorFaces: Set<Int> = []) {
        guard !vertices.isEmpty, !indices.isEmpty, indices.count.isMultiple(of: 3),
              vertices.allSatisfy({ $0.x.isFinite && $0.y.isFinite && $0.z.isFinite }),
              indices.allSatisfy({ Int($0) < vertices.count }) else { return nil }
        low = vertices.reduce(vertices[0], simd_min); high = vertices.reduce(vertices[0], simd_max)
        triangles = stride(from: 0, to: indices.count, by: 3).compactMap { i in
            guard !floorFaces.contains(i / 3) else { return nil }
            return VisionObstacleTriangle(vertices[Int(indices[i])], vertices[Int(indices[i + 1])], vertices[Int(indices[i + 2])])
        }
    }
}

struct VisionObstacleField: Sendable {
    var meshes: [UUID: VisionObstacleMesh] = [:]

    func sample(head: simd_float4x4, floor: Float) -> VisionObstacleSample {
        let position = SIMD3(head.columns.3.x, head.columns.3.y, head.columns.3.z)
        var forward = SIMD3(-head.columns.2.x, 0, -head.columns.2.z)
        // Recover heading from the head's right axis when looking straight up/down.
        if simd_length_squared(forward) < 0.01 { forward = SIMD3(head.columns.0.z, 0, -head.columns.0.x) }
        guard floor.isFinite, position.x.isFinite, position.y.isFinite, position.z.isFinite,
              simd_length_squared(forward).isFinite, simd_length_squared(forward) > 0.0001 else { return .unavailable }
        forward = simd_normalize(forward)
        var nearest: Float = 2.5, found = false, mapped = false
        for mesh in meshes.values {
            let boundsDistance = VisionObstacleTriangle.horizontalDistance(position, low: mesh.low, high: mesh.high)
            // An empty store or only far-away meshes do not mean clear space.
            if boundsDistance < 3.5 { mapped = true }
            guard boundsDistance <= nearest, mesh.high.y > floor + 0.12, mesh.low.y < position.y + 0.25 else { continue }
            for triangle in mesh.triangles {
                if let distance = triangle.distance(head: position, forward: forward, floor: floor, limit: nearest) {
                    nearest = distance; found = true
                }
            }
        }
        return !mapped ? .unavailable : found ? .obstacle(nearest) : .clear
    }
}

// Keep the sky opaque until the OS confirms passthrough. Otherwise fading a
// full immersive scene reveals black, not the person's physical surroundings.
struct VisionObstacleFade {
    private(set) var amount: Float = 1
    private(set) var needsPassthrough = true
    private var clearTime = 0.0

    static func target(distance: Float) -> Float {
        guard distance.isFinite else { return 1 }
        let t = min(1, max(0, 2 - distance))
        return t * t * (3 - 2 * t)
    }

    mutating func update(_ sample: VisionObstacleSample, delta: Double, passthroughVisible: Bool) {
        let dt = delta.isFinite ? min(0.1, max(0, delta)) : 0
        let target: Float, clear: Bool
        switch sample {
        case .unavailable: target = 1; clear = false; needsPassthrough = true
        case .clear: target = 0; clear = true
        case .obstacle(let distance):
            target = Self.target(distance: distance); clear = distance.isFinite && distance >= 2.3
            if !distance.isFinite || distance <= 2.2 { needsPassthrough = true }
        }
        if target <= amount || passthroughVisible {
            let response = target > amount ? 0.10 : 0.55
            amount += (target - amount) * Float(1 - exp(-dt / response))
            if abs(target - amount) < 0.001 { amount = target }
        }
        clearTime = clear && amount == 0 ? clearTime + dt : 0
        // Re-enter full immersion only after the virtual world is opaque and
        // the wearer has remained beyond the release distance for one second.
        if clearTime >= 1 { needsPassthrough = false }
    }
}
