import RealityKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
enum VisionFloorGrid {
    #if os(macOS)
    private typealias GridColor = NSColor
    #else
    private typealias GridColor = UIColor
    #endif

    static func referenceFloor(low: SIMD3<Float>, high: SIMD3<Float>, ground: Float) -> ModelEntity {
        let floor = ModelEntity(mesh: .generateBox(size: SIMD3(max(4, high.x-low.x+2), max(4, high.y-low.y+2), 0.02)),
                                materials: [UnlitMaterial(color: GridColor(red: 0.07, green: 0.105, blue: 0.115, alpha: 1))])
        floor.position = SIMD3((low.x+high.x)/2, (low.y+high.y)/2, ground-0.012)
        return floor
    }

    static func make(low: SIMD3<Float>, high: SIMD3<Float>, ground: Float) async throws -> (entity: Entity, spacing: Float) {
        let root = Entity(); root.name = "地面网格"
        // Project coordinates are Z-up metres. Keep lines aligned to the
        // project origin so virtual travel and sandbox scaling cannot slide it.
        root.position.z = ground + 0.004
        let center = (low + high) / 2
        let minX = floor(min(low.x - 1, center.x - 2)), maxX = ceil(max(high.x + 1, center.x + 2))
        let minY = floor(min(low.y - 1, center.y - 2)), maxY = ceil(max(high.y + 1, center.y + 2))
        // Bound geometry for very large maps while keeping a metric grid. The
        // actual interval is shown next to the visibility switch.
        var spacing: Float = 1
        while max(maxX - minX, maxY - minY) / spacing > 512 { spacing *= 10 }
        var vertices = [[SIMD3<Float>]](repeating: [], count: 4)
        var indices = [[UInt32]](repeating: [], count: 4)
        func line(_ a: SIMD3<Float>, _ b: SIMD3<Float>, group: Int) {
            let d = b - a
            let width: Float = group == 0 ? 0.014 : group == 1 ? 0.028 : 0.04
            let side = simd_normalize(SIMD3(-d.y, d.x, 0)) * width * sqrt(spacing) / 2
            let first = UInt32(vertices[group].count)
            vertices[group] += [a - side, b - side, b + side, a + side]
            indices[group] += [0, 1, 2, 0, 2, 3].map { first + $0 }
        }
        let firstX = Int(ceil(minX / spacing)), lastX = Int(floor(maxX / spacing))
        if firstX <= lastX {
            for i in firstX...lastX {
                let x = Float(i) * spacing
                line(SIMD3(x, minY, 0), SIMD3(x, maxY, 0), group: i == 0 ? 3 : i.isMultiple(of: 5) ? 1 : 0)
            }
        }
        let firstY = Int(ceil(minY / spacing)), lastY = Int(floor(maxY / spacing))
        if firstY <= lastY {
            for i in firstY...lastY {
                let y = Float(i) * spacing
                line(SIMD3(minX, y, 0), SIMD3(maxX, y, 0), group: i == 0 ? 2 : i.isMultiple(of: 5) ? 1 : 0)
            }
        }
        let colors: [GridColor] = [
            GridColor(red: 0.38, green: 0.58, blue: 0.63, alpha: 1),
            GridColor(red: 0.50, green: 0.75, blue: 0.80, alpha: 1),
            GridColor(red: 0.80, green: 0.34, blue: 0.30, alpha: 1),
            GridColor(red: 0.30, green: 0.72, blue: 0.49, alpha: 1)
        ]
        let opacities: [Float] = [0.35, 0.55, 0.62, 0.62]
        for group in vertices.indices where !vertices[group].isEmpty {
            try Task.checkCancellation()
            var descriptor = MeshDescriptor(name: "Floor grid \(group)")
            descriptor.positions = MeshBuffers.Positions(vertices[group])
            descriptor.primitives = .triangles(indices[group])
            let mesh = try await MeshResource(from: [descriptor])
            var material = UnlitMaterial(color: colors[group])
            material.blending = .transparent(opacity: .init(floatLiteral: opacities[group]))
            material.faceCulling = .none
            let entity = ModelEntity(mesh: mesh, materials: [material])
            entity.components.set(DynamicLightShadowComponent(castsShadow: false))
            // Visual aid only: depth testing stays on, with no input or
            // collision components to intercept model selection or landings.
            root.addChild(entity)
        }
        return (root, spacing)
    }
}
