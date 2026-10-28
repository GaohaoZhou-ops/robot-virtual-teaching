import RealityKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
enum VisionParkingLabels {
    #if os(macOS)
    private typealias LabelColor = NSColor
    #else
    private typealias LabelColor = UIColor
    #endif

    static func make(_ markers: [VisionSceneMarker], markerRadius: Float) async throws -> Entity {
        let root = Entity(); root.name = "停车点标签"
        let foreground = UnlitMaterial(color: LabelColor.white)
        let background = UnlitMaterial(color: LabelColor(red: 0.035, green: 0.105, blue: 0.12, alpha: 1))
        // Only parking markers receive labels. Paths and camera keyframes
        // remain unlabelled, and the cards do not intercept spatial input.
        for marker in markers where marker.kind == "parking" {
            try Task.checkCancellation()
            let name = marker.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }
            let title = name.count > 64 ? String(name.prefix(63)) + "…" : name
            let text = ModelEntity(mesh: .generateText(title, extrusionDepth: 0.0005,
                font: .systemFont(ofSize: 0.10, weight: .semibold)), materials: [foreground])
            let bounds = text.visualBounds(relativeTo: text)
            let scale = min(Float(1), 1.4 / max(bounds.extents.x, 0.001))
            text.scale = SIMD3(repeating: scale)
            text.position = SIMD3(-bounds.center.x * scale, -bounds.center.y * scale, 0.004 - bounds.min.z * scale)
            let size = SIMD3<Float>(max(0.18, bounds.extents.x * scale + 0.10), max(0.15, bounds.extents.y * scale + 0.06), 0.006)
            let card = ModelEntity(mesh: .generateBox(size: size, cornerRadius: 0.015), materials: [background])
            card.addChild(text); card.name = marker.id
            card.position = SIMD3(marker.position) + SIMD3(0, 0, markerRadius + 0.08 + size.y / 2)
            card.components.set(BillboardComponent())
            card.components.set(DynamicLightShadowComponent(castsShadow: false))
            text.components.set(DynamicLightShadowComponent(castsShadow: false))
            root.addChild(card)
            await Task.yield()
        }
        return root
    }
}
