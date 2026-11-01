import SceneKit

// A viewing reference in model coordinates, independent of AR plane detection.
enum PoseGroundPlaneRenderer {
    static let nodeName = "pose-model-ground"

    static func makeNode(bounds: (min: SCNVector3, max: SCNVector3)) -> SCNNode? {
        let minimum = SIMD3<Float>(Float(bounds.min.x), Float(bounds.min.y), Float(bounds.min.z))
        let maximum = SIMD3<Float>(Float(bounds.max.x), Float(bounds.max.y), Float(bounds.max.z))
        guard (0..<3).allSatisfy({ minimum[$0].isFinite && maximum[$0].isFinite && minimum[$0] <= maximum[$0] }) else { return nil }
        let extent = maximum - minimum
        let padding = max(max(extent.x, extent.y) * 0.12, 0.05)
        let lower = SIMD2(minimum.x - padding, minimum.y - padding)
        let upper = SIMD2(maximum.x + padding, maximum.y + padding)
        let size = upper - lower
        guard size.x.isFinite, size.y.isFinite, size.x > 0, size.y > 0 else { return nil }

        func material(opacity: CGFloat) -> SCNMaterial {
            let material = SCNMaterial(); material.lightingModel = .constant
            material.diffuse.contents = CGColor(red: 0.55, green: 0.7, blue: 0.75, alpha: 1)
            material.transparency = opacity; material.isDoubleSided = true
            material.readsFromDepthBuffer = true; material.writesToDepthBuffer = false
            return material
        }
        let root = SCNNode(); root.name = nodeName
        // SCNPlane lies in XY with a +Z normal; never move it to the model's bottom.
        let plane = SCNPlane(width: CGFloat(size.x), height: CGFloat(size.y))
        plane.materials = [material(opacity: 0.14)]
        let surface = SCNNode(geometry: plane); surface.name = "z-zero-surface"
        surface.simdPosition = SIMD3(lower.x + size.x / 2, lower.y + size.y / 2, 0)
        surface.renderingOrder = 1; surface.castsShadow = false
        root.addChildNode(surface)

        var vertices: [SCNVector3] = []
        func line(_ start: SIMD2<Float>, _ end: SIMD2<Float>) {
            vertices += [SCNVector3(start.x, start.y, 0), SCNVector3(end.x, end.y, 0)]
        }
        line(lower, SIMD2(upper.x, lower.y)); line(SIMD2(upper.x, lower.y), upper)
        line(upper, SIMD2(lower.x, upper.y)); line(SIMD2(lower.x, upper.y), lower)
        let spacing = max(size.x, size.y) / 12
        for index in 1..<12 {
            let x = lower.x + Float(index) * spacing, y = lower.y + Float(index) * spacing
            if x < upper.x { line(SIMD2(x, lower.y), SIMD2(x, upper.y)) }
            if y < upper.y { line(SIMD2(lower.x, y), SIMD2(upper.x, y)) }
        }
        let grid = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)], elements: [
            SCNGeometryElement(indices: (0..<vertices.count).map(Int32.init), primitiveType: .line)
        ])
        grid.materials = [material(opacity: 0.5)]
        let lines = SCNNode(geometry: grid); lines.name = "z-zero-grid"
        lines.renderingOrder = 2; lines.castsShadow = false
        root.addChildNode(lines)
        return root
    }
}
