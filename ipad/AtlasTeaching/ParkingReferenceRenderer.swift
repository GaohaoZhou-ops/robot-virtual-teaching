import SceneKit
#if canImport(UIKit)
import UIKit
private typealias ParkingColor = UIColor
private typealias ParkingFont = UIFont
#else
import AppKit
private typealias ParkingColor = NSColor
private typealias ParkingFont = NSFont
#endif

// A separate scene layer, with no selection, gesture handlers or writable model.
// Local XY is the parking plane and +X is robot forward, matching desktop RPY.
enum ParkingReferenceRenderer {
    static let nodeName = "readonly-parking-references"

    static func makeNode(_ reference: NavigationReference?) -> SCNNode {
        let root = SCNNode(); root.name = nodeName
        guard let reference else { return root }
        let marker = markerGeometry()
        for point in reference.parkingPoints {
            let node = SCNNode(geometry: marker)
            node.name = "parking-reference-\(point.id)"
            node.simdTransform = point.transform
            root.addChildNode(node)

            let label = SCNNode()
            label.name = "parking-label-\(point.id)"
            let anchor = point.transform * SIMD4<Float>(0, 0, 0.18, 1)
            label.simdPosition = SIMD3(anchor.x, anchor.y, anchor.z)
            let billboard = SCNBillboardConstraint(); billboard.freeAxes = .all
            label.constraints = [billboard]
            let text = SCNText(string: "P · \(point.name)", extrusionDepth: 0)
            text.font = ParkingFont.systemFont(ofSize: 12, weight: .semibold)
            text.flatness = 0.2; text.materials = [material(.white)]
            let (minimum, maximum) = text.boundingBox
            let width = Float(maximum.x - minimum.x), height = Float(maximum.y - minimum.y)
            let scale = min(Float(0.01), 0.9 / max(width, 1))
            let caption = SCNNode(geometry: text)
            caption.simdScale = SIMD3(repeating: scale)
            caption.simdPosition = SIMD3(-Float(minimum.x + maximum.x) * scale / 2,
                                         -Float(minimum.y + maximum.y) * scale / 2, 0.002)
            let background = SCNPlane(width: CGFloat(width * scale + 0.05), height: CGFloat(height * scale + 0.04))
            background.cornerRadius = 0.018
            background.materials = [material(ParkingColor(white: 0.03, alpha: 0.88))]
            label.addChildNode(SCNNode(geometry: background)); label.addChildNode(caption)
            root.addChildNode(label)
        }
        return root
    }

    // Fit parking references outside the object's geometry too. Do not change
    // model geometry/bounds used by placement, coverage or model verification.
    static func bounds(_ reference: NavigationReference?, minimum: SCNVector3,
                       maximum: SCNVector3) -> (min: SCNVector3, max: SCNVector3) {
        var lower = SIMD3<Float>(Float(minimum.x), Float(minimum.y), Float(minimum.z))
        var upper = SIMD3<Float>(Float(maximum.x), Float(maximum.y), Float(maximum.z))
        for point in reference?.parkingPoints ?? [] {
            lower = simd_min(lower, point.position.simd - SIMD3(repeating: 0.55))
            upper = simd_max(upper, point.position.simd + SIMD3(repeating: 0.55))
        }
        return (SCNVector3(lower.x, lower.y, lower.z), SCNVector3(upper.x, upper.y, upper.z))
    }

    private static func material(_ color: ParkingColor) -> SCNMaterial {
        let material = SCNMaterial(); material.lightingModel = .constant
        material.diffuse.contents = color; material.isDoubleSided = true
        return material
    }

    private static func markerGeometry() -> SCNGeometry {
        var vertices: [SCNVector3] = []
        func vertex(_ x: Float, _ y: Float) -> SCNVector3 { SCNVector3(x, y, 0.008) }
        for index in 0..<40 {
            let a = Float(index) * 2 * .pi / 40, b = Float(index + 1) * 2 * .pi / 40
            let innerA = vertex(cos(a) * 0.18, sin(a) * 0.18), outerA = vertex(cos(a) * 0.21, sin(a) * 0.21)
            let innerB = vertex(cos(b) * 0.18, sin(b) * 0.18), outerB = vertex(cos(b) * 0.21, sin(b) * 0.21)
            vertices += [innerA, outerA, outerB, innerA, outerB, innerB]
        }
        vertices += [vertex(-0.08, -0.02), vertex(0.31, -0.02), vertex(0.31, 0.02),
                     vertex(-0.08, -0.02), vertex(0.31, 0.02), vertex(-0.08, 0.02),
                     vertex(0.26, -0.08), vertex(0.44, 0), vertex(0.26, 0.08)]
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)],
                                   elements: [SCNGeometryElement(indices: (0..<vertices.count).map(Int32.init), primitiveType: .triangles)])
        geometry.materials = [material(.systemGreen)]
        return geometry
    }
}
