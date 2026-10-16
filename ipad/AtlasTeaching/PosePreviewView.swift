import SwiftUI
import SceneKit
import Metal

enum PosePreviewMode: String, CaseIterable, Identifiable {
    case interactive = "3d", image = "2d"
    var id: String { rawValue }
}

@MainActor
final class PosePreviewPreparation: ObservableObject {
    @Published private(set) var sampleID: String?
    @Published private(set) var footprint: TeachingCoverageSnapshot?
    @Published private(set) var overview: SCNGeometry?
    @Published private(set) var status = "正在提取当前 Pose 点云…"

    func prepare(sample: TeachingSample, model: ModelGeometry, coverage: TeachingCoverageRenderer) async {
        sampleID = sample.id; footprint = nil
        status = "正在提取当前 Pose 点云…"
        do {
            if overview == nil {
                let build = Task.detached(priority: .userInitiated) { try model.makeThumbnailGeometry() }
                let result = try await withTaskCancellationHandler(operation: { try await build.value }, onCancel: { build.cancel() })
                try Task.checkCancellation()
                overview = result
            }
            let result = try await coverage.previewSnapshot(for: sample)
            try Task.checkCancellation()
            footprint = result
            status = result.frameCount == 0 ? "此 Pose 的记录视野内没有点云" : ""
        } catch {
            guard !Task.isCancelled else { return }
            status = "点云预览失败：\(error.localizedDescription)"
        }
    }
}

struct PosePreviewView: UIViewRepresentable {
    let rendered: SCNGeometry?
    let overview: SCNGeometry?
    let footprint: TeachingCoverageSnapshot?
    let status: String
    let sample: TeachingSample
    let mode: PosePreviewMode
    let resetRevision: Int

    func makeUIView(context: Context) -> PosePreviewSurface { PosePreviewSurface() }
    func updateUIView(_ view: PosePreviewSurface, context: Context) {
        view.update(rendered: rendered, overview: overview, footprint: footprint, status: status,
                    sample: sample, mode: mode, resetRevision: resetRevision)
    }
    static func dismantleUIView(_ view: PosePreviewSurface, coordinator: ()) { view.stop() }
}

/// The recorded camera is independent of the camera used for inspection. Neither
/// gestures nor image rendering can change a saved sample or the live AR scene.
final class PosePreviewSurface: UIView, UIGestureRecognizerDelegate, UIScrollViewDelegate {
    let sceneView = SCNView()
    let imageScrollView = UIScrollView()
    let imageView = UIImageView()
    let object = SCNNode()
    let camera = SCNNode()
    let overviewView = SCNView()
    let overviewCamera = SCNNode()
    let overviewObject = SCNNode()
    private let overviewContainer = UIView()
    private let overviewLabel = UILabel()
    private let statusLabel = UILabel()
    private let recordedScene = SCNScene()
    private let recordedObject = SCNNode()
    private let recordedCamera = SCNNode()
    private weak var sourceGeometry: SCNGeometry?
    private weak var sourceOverview: SCNGeometry?
    private var footprintFrames: MTLBuffer?
    private var controller = SCNCameraController()
    private var sampleID: String?
    private var recordedTransform: [Float] = []
    private var recordedProjection: [Float]?
    private var resetRevision = 0
    private(set) var mode: PosePreviewMode = .interactive
    private var snapshotDirty = true
    private var snapshotSize = CGSize.zero
    private var imageViewportSize = CGSize.zero
    private var imageDetailScale: CGFloat = 1
    private var orbitRadius: Float = 1

    init() {
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        let scene = SCNScene(); scene.background.contents = backgroundColor
        object.name = "preview-object"; scene.rootNode.addChildNode(object)
        scene.rootNode.addChildNode(camera)
        sceneView.scene = scene; sceneView.pointOfView = camera
        sceneView.backgroundColor = backgroundColor
        sceneView.preferredFramesPerSecond = 60
        sceneView.antialiasingMode = .multisampling4X
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = backgroundColor
        imageView.isUserInteractionEnabled = true
        imageScrollView.delegate = self
        imageScrollView.minimumZoomScale = 1; imageScrollView.maximumZoomScale = 8
        imageScrollView.showsHorizontalScrollIndicator = false
        imageScrollView.showsVerticalScrollIndicator = false
        imageScrollView.contentInsetAdjustmentBehavior = .never
        imageScrollView.backgroundColor = backgroundColor
        imageScrollView.isHidden = true
        imageScrollView.addSubview(imageView)
        addSubview(sceneView); addSubview(imageScrollView)
        recordedScene.background.contents = backgroundColor
        recordedScene.rootNode.addChildNode(recordedObject)
        recordedScene.rootNode.addChildNode(recordedCamera)

        let overviewScene = SCNScene()
        overviewScene.rootNode.addChildNode(overviewObject)
        overviewScene.rootNode.addChildNode(overviewCamera)
        overviewCamera.camera = SCNCamera()
        overviewCamera.camera?.usesOrthographicProjection = true
        overviewCamera.camera?.projectionDirection = .vertical
        overviewView.scene = overviewScene; overviewView.pointOfView = overviewCamera
        overviewView.backgroundColor = UIColor(red: 0.035, green: 0.075, blue: 0.09, alpha: 1)
        overviewView.antialiasingMode = .multisampling2X
        overviewView.preferredFramesPerSecond = 60
        overviewContainer.backgroundColor = overviewView.backgroundColor
        overviewContainer.layer.cornerRadius = 12; overviewContainer.clipsToBounds = true
        overviewContainer.layer.borderWidth = 1
        overviewContainer.layer.borderColor = UIColor.white.withAlphaComponent(0.22).cgColor
        overviewContainer.isUserInteractionEnabled = false
        overviewLabel.text = "全局 · 绿色为当前 Pose"
        overviewLabel.textColor = UIColor(red: 0.4, green: 0.95, blue: 0.73, alpha: 1)
        overviewLabel.font = .systemFont(ofSize: 11, weight: .medium)
        overviewLabel.textAlignment = .center
        overviewContainer.addSubview(overviewView); overviewContainer.addSubview(overviewLabel)
        addSubview(overviewContainer)
        statusLabel.textColor = .secondaryLabel; statusLabel.numberOfLines = 0
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.textAlignment = .center
        addSubview(statusLabel)

        // SceneKit's default pinch changes fieldOfView, which is ignored by a
        // saved custom projection. Dolly instead, preserving its exact intrinsics.
        let orbit = UIPanGestureRecognizer(target: self, action: #selector(orbit(_:)))
        orbit.maximumNumberOfTouches = 1
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.minimumNumberOfTouches = 2; pan.maximumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        pan.delegate = self; pinch.delegate = self
        sceneView.addGestureRecognizer(orbit); sceneView.addGestureRecognizer(pan); sceneView.addGestureRecognizer(pinch)
        isAccessibilityElement = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        let gestures = [gestureRecognizer, otherGestureRecognizer]
        return gestures.contains { $0 is UIPinchGestureRecognizer }
            && gestures.contains { ($0 as? UIPanGestureRecognizer)?.minimumNumberOfTouches == 2 }
    }

    func update(rendered: SCNGeometry?, overview: SCNGeometry? = nil,
                footprint: TeachingCoverageSnapshot? = nil, status: String = "",
                sample: TeachingSample, mode: PosePreviewMode, resetRevision: Int) {
        let q = sample.cameraPose.quaternion
        var transform = simd_float4x4(simd_quatf(ix: q.x, iy: q.y, iz: q.z, r: q.w)) * TeachingCoordinates.opticalToARCamera
        transform.columns.3 = SIMD4(sample.cameraPose.position.simd, 1)
        if let saved = sample.previewCameraTransform, saved.count == 16, saved.allSatisfy(\.isFinite) {
            transform = simd_float4x4(elements: saved)
        }
        let projection = sample.previewProjection.flatMap { values in
            values.count == 16 && values.allSatisfy(\.isFinite) ? values : nil
        }
        let poseChanged = sampleID != sample.id || recordedTransform != transform.elements || recordedProjection != projection
        let geometryChanged = sourceGeometry !== rendered
        let footprintChanged = footprintFrames !== footprint?.frames
        if geometryChanged {
            sourceGeometry = rendered; recordedObject.geometry = rendered; snapshotDirty = true
        }
        if geometryChanged || footprintChanged {
            footprintFrames = footprint?.frames
            // Separate materials keep inspection clipping and the selected-Pose
            // highlight out of the live AR model and its aggregate coverage.
            object.geometry = footprint.flatMap { selection in
                guard selection.frameCount > 0, let rendered else { return nil }
                let local = Self.copyForInspection(rendered)
                for material in local.materials {
                    TeachingCoverageRenderer.apply(selection, opacity: 0, to: material, clipOutside: true)
                }
                if let bounds = selection.modelBounds { local.boundingBox = bounds }
                return local
            }
        }
        if sourceOverview !== overview || footprintChanged {
            sourceOverview = overview
            overviewObject.geometry = overview.map(Self.copyForInspection)
            if let footprint, footprint.frameCount > 0 {
                for material in overviewObject.geometry?.materials ?? [] {
                    TeachingCoverageRenderer.apply(footprint, opacity: 0.65, to: material)
                }
            }
        }
        if poseChanged {
            sampleID = sample.id; recordedTransform = transform.elements; recordedProjection = projection
            recordedCamera.simdTransform = transform
            // Use a new camera so legacy samples never inherit a previous Pose's projection.
            let lens = SCNCamera(); lens.zNear = 0.01; lens.zFar = 1000
            lens.projectionDirection = .vertical; lens.fieldOfView = 60
            if let projection { lens.projectionTransform = SCNMatrix4(simd_float4x4(elements: projection)) }
            recordedCamera.camera = lens
            snapshotDirty = true
        }
        if poseChanged {
            restoreRecordedView(); restoreImageView(); imageDetailScale = 1
        } else if self.resetRevision != resetRevision {
            if mode == .image { restoreImageView() }
            else { restoreRecordedView() }
        }
        else if geometryChanged || footprintChanged { updateOrbitTarget() }
        self.resetRevision = resetRevision
        if self.mode != mode {
            imageScrollView.setContentOffset(imageScrollView.contentOffset, animated: false)
        }
        self.mode = mode
        sceneView.isUserInteractionEnabled = mode == .interactive
        sceneView.isHidden = mode == .image
        imageScrollView.isHidden = mode == .interactive
        imageScrollView.isUserInteractionEnabled = mode == .image
        overviewContainer.isHidden = mode == .image || overview == nil
        statusLabel.text = status
        statusLabel.isHidden = mode == .image || status.isEmpty
        if mode == .image { controller.stopInertia() }
        syncOverviewCamera()
        setNeedsLayout()
    }

    private static func copyForInspection(_ geometry: SCNGeometry) -> SCNGeometry {
        let copy = geometry.copy() as! SCNGeometry
        copy.materials = geometry.materials.map { original in
            // SCNMaterial.copy() also copies custom shader values. Live coverage
            // holds MTLBuffers, which do not implement NSCopying on iPad.
            let material = SCNMaterial()
            material.lightingModel = original.lightingModel
            material.isDoubleSided = original.isDoubleSided
            material.diffuse.contents = original.diffuse.contents
            material.emission.contents = original.emission.contents
            material.transparency = original.transparency
            material.blendMode = original.blendMode
            material.fillMode = original.fillMode
            material.cullMode = original.cullMode
            material.readsFromDepthBuffer = original.readsFromDepthBuffer
            material.writesToDepthBuffer = original.writesToDepthBuffer
            return material
        }
        return copy
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sceneView.frame = bounds
        layoutImageViewport()
        let width = min(220, max(136, bounds.width * 0.28), max(0, bounds.width - 24))
        let height = min(width * 0.75 + 28, max(0, bounds.height * 0.42))
        overviewContainer.frame = CGRect(x: bounds.width - width - 12, y: bounds.height - height - 12, width: width, height: height)
        overviewLabel.frame = CGRect(x: 4, y: 4, width: width - 8, height: 24)
        overviewView.frame = CGRect(x: 1, y: 28, width: width - 2, height: max(0, height - 29))
        statusLabel.frame = bounds.insetBy(dx: 24, dy: 24)
        syncOverviewCamera()
        renderRecordedImageIfNeeded()
    }

    private func layoutImageViewport() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        guard imageViewportSize != bounds.size else { imageScrollView.frame = bounds; return }
        let zoom = imageScrollView.zoomScale
        let previous = imageViewportSize
        let offset = imageScrollView.contentOffset
        let center = previous.width > 0 && previous.height > 0
            ? CGPoint(x: (offset.x + previous.width / 2) / (previous.width * zoom),
                      y: (offset.y + previous.height / 2) / (previous.height * zoom))
            : CGPoint(x: 0.5, y: 0.5)
        // Resize the unscaled image, then restore the same part of the frame.
        // Setting a transformed image's frame directly would corrupt its zoom.
        imageScrollView.setZoomScale(1, animated: false)
        imageScrollView.frame = bounds
        imageView.frame = CGRect(origin: .zero, size: bounds.size)
        imageScrollView.contentSize = bounds.size
        imageViewportSize = bounds.size
        imageScrollView.setZoomScale(zoom, animated: false)
        let size = imageScrollView.contentSize
        imageScrollView.contentOffset = CGPoint(
            x: min(max(center.x * size.width - bounds.width / 2, 0), max(size.width - bounds.width, 0)),
            y: min(max(center.y * size.height - bounds.height / 2, 0), max(size.height - bounds.height, 0)))
    }

    private func restoreImageView() {
        imageScrollView.setContentOffset(imageScrollView.contentOffset, animated: false)
        imageScrollView.setZoomScale(1, animated: false)
        imageScrollView.contentOffset = .zero
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        // Keep the image centered during the native bounce below fit-to-screen.
        imageView.center = CGPoint(x: max(scrollView.contentSize.width, scrollView.bounds.width) / 2,
                                   y: max(scrollView.contentSize.height, scrollView.bounds.height) / 2)
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        guard mode == .image, scale > imageDetailScale else { return }
        imageDetailScale = scale
        // Refine only after the pinch finishes so dragging and zooming stay fluid.
        renderRecordedImageIfNeeded()
    }

    func restoreRecordedView() {
        controller.stopInertia()
        camera.simdTransform = recordedCamera.simdTransform
        camera.camera = recordedCamera.camera?.copy() as? SCNCamera
        // SCNCamera.copy() drops a custom projection matrix.
        if let recordedProjection {
            camera.camera?.projectionTransform = SCNMatrix4(simd_float4x4(elements: recordedProjection))
        }
        controller = SCNCameraController()
        controller.pointOfView = camera
        controller.interactionMode = .orbitArcball
        controller.worldUp = SCNVector3(0, 0, 1)
        controller.automaticTarget = false; controller.inertiaEnabled = false
        updateOrbitTarget()
        syncOverviewCamera()
        sceneView.setNeedsDisplay()
    }

    private func updateOrbitTarget() {
        let (minimum, maximum) = object.geometry?.boundingBox ?? recordedObject.boundingBox
        let lower = SIMD3<Float>(minimum.x, minimum.y, minimum.z)
        let upper = SIMD3<Float>(maximum.x, maximum.y, maximum.z)
        let center = (lower + upper) / 2
        orbitRadius = max(simd_length(upper - lower) / 2, 0.05)
        let forward = camera.simdWorldFront
        // Keep the pivot on the recorded optical axis so the first drag cannot
        // snap an off-center Pose toward the origin or the model's bounds center.
        let depth = max(simd_dot(center - camera.simdPosition, forward), orbitRadius * 0.2)
        let target = camera.simdPosition + forward * depth
        controller.target = SCNVector3(target.x, target.y, target.z)
    }

    func syncOverviewCamera() {
        guard let geometry = overviewObject.geometry else { return }
        let (minimum, maximum) = geometry.boundingBox
        let lower = SIMD3<Float>(minimum.x, minimum.y, minimum.z)
        let upper = SIMD3<Float>(maximum.x, maximum.y, maximum.z)
        let center = (lower + upper) / 2
        let radius = max(simd_length(upper - lower) / 2, 0.05)
        overviewCamera.simdOrientation = camera.simdWorldOrientation
        overviewCamera.simdPosition = center - camera.simdWorldFront * (radius * 3)
        let aspect = Float(overviewView.bounds.width / max(overviewView.bounds.height, 1))
        overviewCamera.camera?.orthographicScale = Double(radius * 1.15 / max(min(aspect, 1), 0.1))
        overviewCamera.camera?.zNear = Double(max(radius * 0.01, 0.001))
        overviewCamera.camera?.zFar = Double(radius * 6)
        overviewView.setNeedsDisplay()
    }

    private func renderRecordedImageIfNeeded() {
        guard mode == .image, recordedObject.geometry != nil, bounds.width > 1, bounds.height > 1 else {
            if recordedObject.geometry == nil { imageView.image = nil }
            return
        }
        // Bound memory even on a Retina iPad; cache only the selected Pose.
        let scale = min((window?.screen.scale ?? 2) * imageDetailScale, 3200 / max(bounds.width, bounds.height))
        let size = CGSize(width: (bounds.width * scale).rounded(), height: (bounds.height * scale).rounded())
        guard snapshotDirty || size != snapshotSize else { return }
        let renderer = SCNRenderer(device: sceneView.device, options: nil)
        renderer.scene = recordedScene; renderer.pointOfView = recordedCamera
        imageView.image = renderer.snapshot(atTime: 0, with: size, antialiasingMode: .multisampling4X)
        snapshotSize = size; snapshotDirty = false
    }

    @objc private func orbit(_ gesture: UIPanGestureRecognizer) {
        guard mode == .interactive else { return }
        let location = gesture.location(in: sceneView)
        switch gesture.state {
        case .began: controller.beginInteraction(location, withViewport: bounds.size)
        case .changed: controller.continueInteraction(location, withViewport: bounds.size, sensitivity: 1)
        case .ended, .cancelled, .failed:
            controller.endInteraction(location, withViewport: bounds.size, velocity: .zero)
        default: break
        }
        syncOverviewCamera()
        sceneView.setNeedsDisplay()
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .changed else { return }
        translate(by: gesture.translation(in: sceneView))
        gesture.setTranslation(.zero, in: sceneView)
    }

    func translate(by translation: CGPoint) {
        guard mode == .interactive, bounds.height > 0 else { return }
        let target = SIMD3<Float>(controller.target.x, controller.target.y, controller.target.z)
        let distance = max(simd_distance(camera.simdPosition, target), 0.01)
        let projection = camera.camera.map { simd_float4x4($0.projectionTransform) } ?? matrix_identity_float4x4
        let xScale = 2 * distance / max(abs(projection.columns.0.x) * Float(bounds.width), 1)
        let yScale = 2 * distance / max(abs(projection.columns.1.y) * Float(bounds.height), 1)
        let delta = camera.simdWorldRight * (-Float(translation.x) * xScale)
            + camera.simdWorldUp * (Float(translation.y) * yScale)
        camera.simdPosition += delta
        let shifted = target + delta; controller.target = SCNVector3(shifted.x, shifted.y, shifted.z)
        sceneView.setNeedsDisplay()
    }

    @objc private func pinch(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.state == .changed else { return }
        zoom(by: Float(gesture.scale)); gesture.scale = 1
    }

    func zoom(by scale: Float) {
        guard mode == .interactive, scale.isFinite, scale > 0 else { return }
        let target = SIMD3<Float>(controller.target.x, controller.target.y, controller.target.z)
        let offset = camera.simdPosition - target, distance = simd_length(offset)
        guard distance > 0.0001 else { return }
        let minimum = max(orbitRadius * 0.01, 0.015)
        let maximum = max(orbitRadius * 100, 100)
        let next = min(max(distance / scale, minimum), maximum)
        camera.simdPosition = target + offset * (next / distance)
        sceneView.setNeedsDisplay()
    }

    func stop() {
        controller.stopInertia(); sceneView.isPlaying = false; overviewView.isPlaying = false
        imageScrollView.setContentOffset(imageScrollView.contentOffset, animated: false)
    }
}
