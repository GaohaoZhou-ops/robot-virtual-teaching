import Foundation
import CoreGraphics
import ImageIO
import simd

enum VisionSceneCameraTests {
    static func pixels(_ image: CGImage) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        bytes.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }
    static func center(_ image: CGImage) -> [UInt8] {
        let bytes = pixels(image), offset = (image.height / 2 * image.width + image.width / 2) * 4
        return Array(bytes[offset..<offset + 3])
    }
    static func lookingAlongY(at position: SIMD3<Float>) -> simd_float4x4 {
        simd_float4x4(columns: (SIMD4(1, 0, 0, 0), SIMD4(0, 0, -1, 0), SIMD4(0, 1, 0, 0), SIMD4(position, 1)))
    }
    static func run(_ scene: VisionSceneManifest, store: VisionSceneStore) async throws {
        let renderer = VisionSceneCameraRenderer(); try await renderer.prepare(scene, store: store)
        var world: [String: simd_float4x4] = [:]
        for node in scene.nodes {
            world[node.id] = (node.parent.flatMap { world[$0] } ?? matrix_identity_float4x4) * simd_float4x4(elements: node.transform)
        }
        let left = scene.cameraNodes[.left]!, right = scene.cameraNodes[.right]!
        world[left] = lookingAlongY(at: SIMD3(-1.5, -0.7, 0.4))
        world[right] = lookingAlongY(at: SIMD3(1.5, 0.75, 0.9))
        var snapshot = VisionSceneCameraSnapshot(transforms: world)
        let frames = try await renderer.frames(snapshot)
        precondition(frames.count == 2)
        for image in frames.values {
            precondition(image.width == 648 && image.height == 400)
            // Height colors are saturated; a visible blue/green surface need
            // not have a bright red channel like the original gray fixture.
            precondition(center(image).max()! > 100, "Optical +Z must see the model in front of each camera")
        }
        precondition(pixels(frames[.left]!) != pixels(frames[.right]!), "Left and right must render separate viewpoints")
        if let path = ProcessInfo.processInfo.environment["VISION_CAMERA_ARTIFACTS"] {
            let directory = URL(fileURLWithPath: path)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for (side, image) in frames {
                let destination = CGImageDestinationCreateWithURL(directory.appendingPathComponent("\(side.rawValue).png") as CFURL, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, image, nil); precondition(CGImageDestinationFinalize(destination))
            }
        }

        snapshot.transforms[left] = world[right]
        let moved = try await renderer.frames(snapshot)
        precondition(pixels(moved[.left]!) == pixels(frames[.right]!), "A changed optical pose must update the next frame")

        // The same centre ray sees neither a surface beyond 1.3 m nor one
        // closer than 0.3 m. Other geometry may still appear at the edges.
        for y: Float in [-3, -0.2] {
            snapshot.transforms[left] = lookingAlongY(at: SIMD3(-1.5, y, 0.4))
            let clipped = try await renderer.frames(snapshot)
            precondition(center(clipped[.left]!).allSatisfy { $0 < 70 }, "M70 near/far clipping must be applied")
        }

        // A loose point remains visible when the source map also has meshes.
        snapshot.transforms = world.filter { entry in
            !scene.nodes.contains { node in node.id == entry.key && node.role == "map" &&
                scene.assets.contains { $0.id == node.asset && $0.manifest.indices > 0 } }
        }
        snapshot.transforms[left] = lookingAlongY(at: SIMD3(0, -0.7, 1.2))
        let pointFrame = try await renderer.frames(snapshot)
        precondition(center(pointFrame[.left]!).max()! > 100, "Loose map points must appear in virtual camera images")

        snapshot.transforms.removeValue(forKey: right)
        let single = try await renderer.frames(snapshot)
        precondition(single[.left] != nil && single[.right] == nil, "Missing optical transforms cannot reuse a stale camera image")
        snapshot.transforms.removeValue(forKey: left)
        do { _ = try await renderer.frames(snapshot); preconditionFailure("Missing camera poses must allow a retry") }
        catch is TeachingError { }
        print("Virtual Zivid cameras: desktop/native playback transforms, separate model views, pose refresh, M70 clipping and mixed-map point rendering passed.")
    }
}
