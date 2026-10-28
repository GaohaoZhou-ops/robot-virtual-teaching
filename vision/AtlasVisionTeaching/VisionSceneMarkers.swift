import RealityKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
enum VisionSceneMarkers {
    static func material(for marker: VisionSceneMarker, arrived: Bool = false) -> UnlitMaterial {
        if marker.kind == "camera" { return UnlitMaterial(color: .systemYellow) }
        if arrived { return arrivalMaterial() }
        // Match PointCloudViewer's WAYPOINT_DEFAULT_COLOR (#ffd166, sRGB).
        // A system semantic color changes the hue; post-process tone mapping
        // would change these display colors again after the unlit shader.
        return unlit(red: 1, green: 209.0 / 255, blue: 102.0 / 255)
    }

    static func arrivalMaterial() -> UnlitMaterial {
        unlit(red: 74.0 / 255, green: 222.0 / 255, blue: 128.0 / 255)
    }

    private static func unlit(red: CGFloat, green: CGFloat, blue: CGFloat) -> UnlitMaterial {
        #if os(macOS)
        let color = NSColor(srgbRed: red, green: green, blue: blue, alpha: 1)
        #else
        let color = UIColor(red: red, green: green, blue: blue, alpha: 1)
        #endif
        var material = UnlitMaterial(applyPostProcessToneMap: false)
        material.color = .init(tint: color)
        return material
    }
}
