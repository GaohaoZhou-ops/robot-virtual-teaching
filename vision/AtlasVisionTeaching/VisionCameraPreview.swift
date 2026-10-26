import SceneKit
import UIKit
import Metal

/// A small, offscreen geometric view of the authored optical frame. SceneKit is
/// isolated here; RealityKit continues to render the immersive scene locally.
actor VisionCameraPreview {
    private var renderer: SCNRenderer?
    private let camera = SCNNode()

    func prepare(_ model: ModelGeometry) throws {
        try Task.checkCancellation()
        let scene = SCNScene()
        scene.background.contents = UIColor(red: 0.025, green: 0.045, blue: 0.065, alpha: 1)
        let geometry = try model.makeThumbnailGeometry()
        let material = SCNMaterial()
        material.lightingModel = .constant; material.isDoubleSided = true
        geometry.materials = [material]
        scene.rootNode.addChildNode(SCNNode(geometry: geometry))
        camera.camera = SCNCamera()
        camera.camera?.projectionDirection = .vertical
        camera.camera?.fieldOfView = CGFloat(ZividFieldOfView.verticalDegrees)
        camera.camera?.zNear = 0.3; camera.camera?.zFar = 1.3
        scene.rootNode.addChildNode(camera)
        let renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
        renderer.scene = scene; renderer.pointOfView = camera
        self.renderer = renderer
    }

    func image(_ optical: simd_float4x4) -> UIImage? {
        guard let renderer, !Task.isCancelled else { return nil }
        camera.simdTransform = optical * TeachingCoordinates.opticalToARCamera
        return renderer.snapshot(atTime: 0, with: CGSize(width: 486, height: 300), antialiasingMode: .multisampling2X)
    }
}
