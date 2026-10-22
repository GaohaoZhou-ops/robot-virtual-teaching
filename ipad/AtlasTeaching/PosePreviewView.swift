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
            status = result.frameCount == 0 ? "此 Pose 的 M70 视野与工作距离内没有点云" : ""
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
    var navigationReference: NavigationReference? = nil
    @Binding var showsCameraPose: Bool
    @Binding var showsModelOrigin: Bool
    @Binding var overviewExpanded: Bool

    func makeUIView(context: Context) -> PosePreviewSurface { PosePreviewSurface() }
    func updateUIView(_ view: PosePreviewSurface, context: Context) {
        view.onCameraPoseVisibilityChange = { showsCameraPose = $0 }
        view.onModelOriginVisibilityChange = { showsModelOrigin = $0 }
        view.onOverviewExpansionChange = { overviewExpanded = $0 }
        view.update(rendered: rendered, overview: overview, footprint: footprint, status: status,
                    sample: sample, mode: mode, resetRevision: resetRevision, navigationReference: navigationReference)
        view.setCameraPoseVisible(showsCameraPose)
        view.setModelOriginVisible(showsModelOrigin)
        view.setOverviewExpanded(overviewExpanded && mode == .interactive)
    }
    static func dismantleUIView(_ view: PosePreviewSurface, coordinator: ()) { view.stop() }
}

private final class PoseOverviewContainer: UIView {
    var onActivate: (() -> Void)?
    override func accessibilityActivate() -> Bool {
        guard let onActivate else { return false }
        onActivate(); return true
    }
}

/// Uses the same M70 optical frame and lens as the selected surface mask.
/// The cone ends at the furthest visible surface within the working range.
struct PoseCameraProjection {
    let category: TeachingPoseCategory
    let modelFromCamera: simd_float4x4
    let frustum: TeachingCoverageFrustum
    let surfaceDepth: Float?

    init?(sample: TeachingSample, footprint: TeachingCoverageSnapshot?) {
        guard let recorded = try? TeachingCoverageFrustum.recordedView(sample) else { return nil }
        let transform = recorded.cameraFromModel.inverse
        guard transform.elements.allSatisfy(\.isFinite) else { return nil }
        modelFromCamera = transform; frustum = recorded.frustum; category = sample.category
        var furthest: Float?
        if let footprint, footprint.frameCount == 1, let frames = footprint.frames, let depths = footprint.depths,
           frames.length >= MemoryLayout<simd_float4x4>.stride,
           depths.length >= footprint.frustum.columns * footprint.frustum.rows * MemoryLayout<Float>.stride {
            let frame = frames.contents().load(as: simd_float4x4.self)
            // A late footprint for another selection must never project from this camera.
            if zip(frame.elements, recorded.cameraFromModel.elements).allSatisfy({ abs($0 - $1) < 0.0001 }) {
                let count = footprint.frustum.columns * footprint.frustum.rows
                let values = depths.contents().bindMemory(to: Float.self, capacity: count)
                for index in 0..<count {
                    let depth = values[index]
                    if depth.isFinite && depth >= frustum.near && depth <= frustum.far {
                        furthest = max(furthest ?? depth, depth)
                    }
                }
            }
        }
        surfaceDepth = furthest
    }

    var corners: [SIMD3<Float>] {
        guard let depth = surfaceDepth else { return [] }
        return [SIMD2<Float>(-1, -1), SIMD2(1, -1), SIMD2(1, 1), SIMD2(-1, 1)].map {
            SIMD3(($0.x - frustum.offset.x) * depth * frustum.tangents.x,
                  ($0.y - frustum.offset.y) * depth * frustum.tangents.y, depth)
        }
    }

    func makeNode(modelRadius: Float) -> SCNNode {
        let node = SCNNode(); node.simdTransform = modelFromCamera
        let size = max(modelRadius, (surfaceDepth ?? 0) * 0.5, 0.3) * 0.045
        let rgb = category.rgb
        let tint = UIColor(red: CGFloat(rgb.x), green: CGFloat(rgb.y), blue: CGFloat(rgb.z), alpha: 1)
        func material(_ color: UIColor, opacity: CGFloat = 1) -> SCNMaterial {
            let material = SCNMaterial(); material.lightingModel = .constant
            material.diffuse.contents = color; material.isDoubleSided = true
            material.transparency = opacity; material.writesToDepthBuffer = opacity == 1
            return material
        }
        func add(_ geometry: SCNGeometry, at position: SIMD3<Float>, color: UIColor) -> SCNNode {
            geometry.materials = [material(color)]
            let child = SCNNode(geometry: geometry); child.simdPosition = position
            node.addChildNode(child); return child
        }
        func line(_ start: SIMD3<Float>, _ end: SIMD3<Float>, radius: Float, color: UIColor, opacity: CGFloat = 1) {
            let delta = end - start, length = simd_length(delta)
            guard length > 0.000001 else { return }
            let cylinder = SCNCylinder(radius: CGFloat(radius), height: CGFloat(length))
            cylinder.radialSegmentCount = 6; cylinder.materials = [material(color, opacity: opacity)]
            let edge = SCNNode(geometry: cylinder)
            edge.simdPosition = (start + end) / 2
            edge.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: delta / length)
            node.addChildNode(edge)
        }
        let body = SCNBox(width: CGFloat(size * 1.4), height: CGFloat(size), length: CGFloat(size * 0.7), chamferRadius: CGFloat(size * 0.12))
        add(body, at: SIMD3(0, 0, -size * 0.55), color: tint).name = "camera-body"
        let lens = SCNCylinder(radius: CGFloat(size * 0.32), height: CGFloat(size * 0.4))
        lens.radialSegmentCount = 16
        add(lens, at: SIMD3(0, 0, -size * 0.08), color: .white)
            .simdOrientation = simd_quatf(angle: .pi / 2, axis: SIMD3(1, 0, 0))
        // An asymmetric top and RGB optical axes make camera roll visible too.
        let top = SCNBox(width: CGFloat(size * 0.6), height: CGFloat(size * 0.25), length: CGFloat(size * 0.4), chamferRadius: 0)
        _ = add(top, at: SIMD3(0, -size * 0.6, -size * 0.55), color: tint)
        for (direction, color) in [(SIMD3<Float>(1, 0, 0), UIColor.systemRed),
                                    (SIMD3<Float>(0, 1, 0), UIColor.systemGreen),
                                    (SIMD3<Float>(0, 0, 1), UIColor.systemBlue)] {
            line(.zero, direction * size * 1.9, radius: size * 0.045, color: color)
            let arrow = SCNCone(topRadius: 0, bottomRadius: CGFloat(size * 0.12), height: CGFloat(size * 0.35))
            arrow.radialSegmentCount = 8
            add(arrow, at: direction * size * 2, color: color)
                .simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: direction)
        }
        let corners = corners
        if corners.count == 4 {
            for index in 0..<4 {
                line(.zero, corners[index], radius: size * 0.022, color: tint, opacity: 0.8)
                line(corners[index], corners[(index + 1) % 4], radius: size * 0.022, color: tint, opacity: 0.8)
            }
            let vertices = ([SIMD3<Float>.zero] + corners).map { SCNVector3($0.x, $0.y, $0.z) }
            let faces = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)], elements: [
                SCNGeometryElement(indices: [Int32(0), 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1], primitiveType: .triangles)
            ])
            faces.materials = [material(tint, opacity: 0.045)]
            let cone = SCNNode(geometry: faces); cone.name = "camera-projection"
            cone.renderingOrder = 1; node.addChildNode(cone)
        }
        return node
    }
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
    let overviewPose = SCNNode()
    let overviewOrigin = SCNNode()
    let cameraPoseSwitch = UISwitch()
    let modelOriginSwitch = UISwitch()
    let overviewCollapseButton = UIButton(type: .system)
    private let cameraPoseControl = UIStackView()
    private let modelOriginControl = UIStackView()
    private let overviewContainer = PoseOverviewContainer()
    private let overviewDoubleTap = UITapGestureRecognizer()
    private let statusLabel = UILabel()
    private let recordedScene = SCNScene()
    private let recordedObject = SCNNode()
    private let recordedCamera = SCNNode()
    private weak var sourceGeometry: SCNGeometry?
    private weak var sourceOverview: SCNGeometry?
    private var navigationReference: NavigationReference?
    private var footprintFrames: MTLBuffer?
    private var overviewFootprint: TeachingCoverageSnapshot?
    private var controller = SCNCameraController()
    private var overviewController = SCNCameraController()
    private var overviewRadius: Float = 1
    private var pendingOverviewFit = false
    private(set) var overviewExpanded = false
    private(set) var showsCameraPose = false
    private(set) var showsModelOrigin = false
    var onCameraPoseVisibilityChange: ((Bool) -> Void)?
    var onModelOriginVisibilityChange: ((Bool) -> Void)?
    var onOverviewExpansionChange: ((Bool) -> Void)?
    private var sampleID: String?
    private var sampleCategory: TeachingPoseCategory?
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
        overviewScene.rootNode.addChildNode(overviewPose)
        overviewPose.name = "selected-pose-camera"; overviewPose.isHidden = true
        overviewScene.rootNode.addChildNode(overviewOrigin)
        overviewOrigin.name = "model-coordinate-origin"; overviewOrigin.isHidden = true
        buildModelOriginAxes()
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
        overviewView.isUserInteractionEnabled = false
        overviewView.accessibilityIdentifier = "pose-global-overview"
        overviewView.accessibilityLabel = "全局点云，着色为当前 Pose"
        overviewView.accessibilityHint = "单指旋转，双指平移，捏合缩放"
        overviewCollapseButton.setImage(UIImage(systemName: "arrow.down.right.and.arrow.up.left",
            withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)), for: .normal)
        overviewCollapseButton.tintColor = .white.withAlphaComponent(0.85)
        overviewCollapseButton.backgroundColor = UIColor.black.withAlphaComponent(0.4)
        overviewCollapseButton.layer.cornerRadius = 12
        overviewCollapseButton.layer.borderWidth = 1
        overviewCollapseButton.layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
        overviewCollapseButton.accessibilityLabel = "收起全局视图"
        overviewCollapseButton.accessibilityIdentifier = "collapse-pose-overview"
        overviewCollapseButton.isHidden = true
        overviewCollapseButton.addTarget(self, action: #selector(collapseOverview), for: .touchUpInside)
        overviewContainer.addSubview(overviewView)
        overviewContainer.addSubview(overviewCollapseButton)
        for (title, toggle, control, identifier, action) in [
            ("相机姿态与投影", cameraPoseSwitch, cameraPoseControl, "pose-camera-projection-toggle", #selector(cameraPoseToggled)),
            ("模型坐标原点", modelOriginSwitch, modelOriginControl, "pose-model-origin-toggle", #selector(modelOriginToggled))
        ] {
            let label = UILabel(); label.text = title; label.textColor = .white.withAlphaComponent(0.9)
            label.font = .preferredFont(forTextStyle: .subheadline)
            label.adjustsFontForContentSizeCategory = true
            toggle.onTintColor = UIColor(red: 0.2, green: 0.8, blue: 0.85, alpha: 1)
            toggle.accessibilityLabel = title; toggle.accessibilityIdentifier = identifier
            toggle.addTarget(self, action: action, for: .valueChanged)
            control.axis = .horizontal; control.alignment = .center; control.spacing = 8
            control.addArrangedSubview(label); control.addArrangedSubview(toggle)
            control.isLayoutMarginsRelativeArrangement = true
            control.layoutMargins = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
            control.backgroundColor = UIColor.black.withAlphaComponent(0.4)
            control.layer.cornerRadius = 12; control.layer.borderWidth = 1
            control.layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
            control.isHidden = true; overviewContainer.addSubview(control)
        }
        modelOriginSwitch.accessibilityHint = "显示模型原点，X 红色、Y 绿色、Z 蓝色"
        overviewContainer.isAccessibilityElement = true
        overviewContainer.accessibilityTraits = .button
        overviewContainer.accessibilityIdentifier = "pose-global-thumbnail"
        overviewContainer.accessibilityLabel = "全局缩略图，着色为当前 Pose"
        overviewContainer.accessibilityHint = "双击放大全局视图"
        overviewContainer.onActivate = { [weak self] in self?.expandOverview() }
        updateOverviewAccessibility()
        overviewDoubleTap.numberOfTapsRequired = 2
        overviewDoubleTap.addTarget(self, action: #selector(expandOverview))
        overviewContainer.addGestureRecognizer(overviewDoubleTap)
        let overviewOrbit = UIPanGestureRecognizer(target: self, action: #selector(orbitOverview(_:)))
        overviewOrbit.maximumNumberOfTouches = 1
        let overviewPan = UIPanGestureRecognizer(target: self, action: #selector(panOverview(_:)))
        overviewPan.minimumNumberOfTouches = 2; overviewPan.maximumNumberOfTouches = 2
        let overviewPinch = UIPinchGestureRecognizer(target: self, action: #selector(pinchOverview(_:)))
        overviewPan.delegate = self; overviewPinch.delegate = self
        overviewView.addGestureRecognizer(overviewOrbit)
        overviewView.addGestureRecognizer(overviewPan); overviewView.addGestureRecognizer(overviewPinch)
        addSubview(overviewContainer)
        statusLabel.textColor = .secondaryLabel; statusLabel.numberOfLines = 0
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.textAlignment = .center
        addSubview(statusLabel)
        bringSubviewToFront(overviewContainer)

        // SceneKit's default pinch changes fieldOfView, which is ignored by a
        // saved custom projection. Dolly instead, preserving its exact intrinsics.
        let orbit = UIPanGestureRecognizer(target: self, action: #selector(orbit(_:)))
        orbit.maximumNumberOfTouches = 1
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.minimumNumberOfTouches = 2; pan.maximumNumberOfTouches = 2
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinch(_:)))
        pan.delegate = self; pinch.delegate = self
        sceneView.addGestureRecognizer(orbit); sceneView.addGestureRecognizer(pan); sceneView.addGestureRecognizer(pinch)
        isAccessibilityElement = false
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
                sample: TeachingSample, mode: PosePreviewMode, resetRevision: Int,
                navigationReference: NavigationReference? = nil) {
        if self.navigationReference != navigationReference {
            self.navigationReference = navigationReference
            let root = overviewView.scene?.rootNode
            root?.childNode(withName: ParkingReferenceRenderer.nodeName, recursively: false)?.removeFromParentNode()
            root?.addChildNode(ParkingReferenceRenderer.makeNode(navigationReference))
            pendingOverviewFit = true
        }
        let q = sample.cameraPose.quaternion
        var transform = simd_float4x4(simd_quatf(ix: q.x, iy: q.y, iz: q.z, r: q.w)) * TeachingCoordinates.opticalToARCamera
        transform.columns.3 = SIMD4(sample.cameraPose.position.simd, 1)
        let projection = ZividFieldOfView.projectionMatrix.elements
        let poseChanged = sampleID != sample.id || sampleCategory != sample.category || recordedTransform != transform.elements || recordedProjection != projection
        let geometryChanged = sourceGeometry !== rendered
        let overviewChanged = sourceOverview !== overview
        let footprintChanged = footprintFrames !== footprint?.frames
        overviewFootprint = footprint
        let sourceLabel = sample.category.label
        overviewView.accessibilityLabel = "全局点云，当前 Pose 来源：\(sourceLabel)"
        overviewContainer.accessibilityLabel = "全局缩略图，当前 Pose 来源：\(sourceLabel)"
        if geometryChanged {
            sourceGeometry = rendered
            // The recorded camera image shows original surface colors. Live
            // coverage changes must stay on the global model, including on rerender.
            recordedObject.geometry = rendered.map(Self.copyForInspection)
            snapshotDirty = true
        }
        if geometryChanged || footprintChanged {
            footprintFrames = footprint?.frames
            // Keep the selected surface in its original colors while clipping
            // outside the Pose. Global coverage uses its own tinted materials.
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
        if sourceOverview !== overview || footprintChanged || (overviewExpanded && geometryChanged) {
            sourceOverview = overview
            updateOverviewGeometry()
        }
        if poseChanged {
            sampleID = sample.id; sampleCategory = sample.category; recordedTransform = transform.elements; recordedProjection = projection
            recordedCamera.simdTransform = transform
            let lens = SCNCamera(); lens.zNear = Double(ZividFieldOfView.near); lens.zFar = Double(ZividFieldOfView.far)
            lens.projectionDirection = .vertical; lens.fieldOfView = ZividFieldOfView.verticalDegrees
            lens.projectionTransform = SCNMatrix4(simd_float4x4(elements: projection))
            recordedCamera.camera = lens
            snapshotDirty = true
        }
        if poseChanged || footprintChanged || overviewChanged {
            overviewPose.childNodes.forEach { $0.removeFromParentNode() }
            let projection = PoseCameraProjection(sample: sample, footprint: footprint)
            if let projection {
                let bounds = (overview ?? rendered)?.boundingBox
                let radius = bounds.map { simd_length(SIMD3<Float>($0.max.x - $0.min.x, $0.max.y - $0.min.y, $0.max.z - $0.min.z)) / 2 } ?? 1
                overviewPose.addChildNode(projection.makeNode(modelRadius: radius))
            }
            cameraPoseSwitch.isEnabled = projection != nil
            overviewPose.isHidden = !showsCameraPose || projection == nil
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
        if mode == .image || overview == nil { setOverviewExpanded(false) }
        sceneView.isUserInteractionEnabled = mode == .interactive && !overviewExpanded
        sceneView.isHidden = mode == .image || overviewExpanded
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
        sceneView.frame = ZividFieldOfView.fittedFrame(in: bounds.size)
        layoutImageViewport()
        let width = min(220, max(136, bounds.width * 0.28), max(0, bounds.width - 24))
        let height = min(width * 0.75, max(0, bounds.height * 0.42))
        if overviewExpanded {
            overviewContainer.frame = bounds
            overviewView.frame = overviewContainer.bounds
            overviewCollapseButton.frame = CGRect(x: 12, y: 12, width: 44, height: 44)
            let controls = [cameraPoseControl, modelOriginControl]
            let sizes = controls.map { $0.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize) }
            let controlWidth = min(sizes.map(\.width).max() ?? 0, max(0, bounds.width - 80))
            var controlY: CGFloat = 12
            for (control, size) in zip(controls, sizes) {
                control.frame = CGRect(x: bounds.width - controlWidth - 12, y: controlY,
                                       width: controlWidth, height: max(44, size.height))
                controlY = control.frame.maxY + 8
            }
        } else {
            overviewContainer.frame = CGRect(x: bounds.width - width - 12, y: bounds.height - height - 12, width: width, height: height)
            overviewView.frame = overviewContainer.bounds.insetBy(dx: 1, dy: 1)
        }
        statusLabel.frame = bounds.insetBy(dx: 24, dy: 24)
        if pendingOverviewFit { fitOverviewCamera() }
        else { syncOverviewCamera() }
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
        // The inspection camera starts with the captured framing, but it is
        // independent of the physical capture camera. Moving around an already
        // captured cloud must never recrop it to M70's 0.3–1.3 m working range.
        let lens = recordedCamera.camera?.copy() as? SCNCamera ?? SCNCamera()
        let near: Float = 0.001, far: Float = 1000
        lens.zNear = Double(near); lens.zFar = Double(far)
        camera.camera = lens
        // SCNCamera.copy() drops a custom projection matrix. Preserve image
        // framing while replacing only its depth planes for free inspection.
        if let recordedProjection {
            var projection = simd_float4x4(elements: recordedProjection)
            projection[2].z = -(far + near) / (far - near)
            projection[3].z = -2 * far * near / (far - near)
            lens.projectionTransform = SCNMatrix4(projection)
        }
        controller = SCNCameraController()
        controller.pointOfView = camera
        controller.interactionMode = .orbitArcball
        controller.worldUp = SCNVector3(0, 0, 1)
        controller.automaticTarget = false; controller.inertiaEnabled = false
        updateOrbitTarget()
        if overviewExpanded { fitOverviewCamera() } else { syncOverviewCamera() }
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
        guard !overviewExpanded else { return }
        fitOverviewCamera()
    }

    private func fitOverviewCamera() {
        guard let geometry = overviewObject.geometry else { return }
        guard overviewView.bounds.width > 0, overviewView.bounds.height > 0 else {
            pendingOverviewFit = true; return
        }
        pendingOverviewFit = false
        // Include parking references but exclude origin axes and camera rays.
        let (minimum, maximum) = ParkingReferenceRenderer.bounds(navigationReference,
            minimum: geometry.boundingBox.min, maximum: geometry.boundingBox.max)
        let lower = SIMD3<Float>(minimum.x, minimum.y, minimum.z)
        let upper = SIMD3<Float>(maximum.x, maximum.y, maximum.z)
        let center = (lower + upper) / 2
        let radius = max(simd_length(upper - lower) / 2, 0.05)
        overviewRadius = radius
        overviewCamera.simdOrientation = camera.simdWorldOrientation
        overviewCamera.simdPosition = center - overviewCamera.simdWorldFront * (radius * 3)
        let aspect = Float(overviewView.bounds.width / max(overviewView.bounds.height, 1))
        // Use the same tighter framing in the thumbnail and expanded view,
        // keeping the complete bounding sphere visible through rotation.
        overviewCamera.camera?.orthographicScale = Double(radius / max(min(aspect, 1), 0.1))
        overviewCamera.camera?.zNear = Double(max(radius * 0.01, 0.001))
        overviewCamera.camera?.zFar = Double(radius * 6)
        if overviewExpanded {
            overviewController.stopInertia()
            overviewController = SCNCameraController()
            overviewController.pointOfView = overviewCamera
            overviewController.interactionMode = .orbitArcball
            overviewController.worldUp = SCNVector3(0, 0, 1)
            overviewController.automaticTarget = false; overviewController.inertiaEnabled = false
            overviewController.target = SCNVector3(center.x, center.y, center.z)
        }
        overviewView.setNeedsDisplay()
    }

    private func buildModelOriginAxes() {
        func material(_ color: UIColor) -> SCNMaterial {
            let material = SCNMaterial(); material.lightingModel = .constant
            material.diffuse.contents = color; material.isDoubleSided = true
            // Keep the coordinate reference visible even when the origin is inside the model.
            material.readsFromDepthBuffer = false; material.writesToDepthBuffer = false
            return material
        }
        let center = SCNSphere(radius: 0.04); center.segmentCount = 12
        center.materials = [material(.white)]
        let dot = SCNNode(geometry: center); dot.renderingOrder = 20
        overviewOrigin.addChildNode(dot)
        for (name, direction, color) in [("X", SIMD3<Float>(1, 0, 0), UIColor.systemRed),
                                        ("Y", SIMD3<Float>(0, 1, 0), UIColor.systemGreen),
                                        ("Z", SIMD3<Float>(0, 0, 1), UIColor.systemBlue)] {
            let axis = SCNNode(); axis.name = "model-origin-\(name)"
            axis.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: direction)
            let shaft = SCNCylinder(radius: 0.018, height: 0.8); shaft.radialSegmentCount = 8
            let arrow = SCNCone(topRadius: 0, bottomRadius: 0.065, height: 0.2); arrow.radialSegmentCount = 12
            for (geometry, y) in [(shaft as SCNGeometry, Float(0.4)), (arrow as SCNGeometry, Float(0.9))] {
                geometry.materials = [material(color)]
                let node = SCNNode(geometry: geometry); node.simdPosition.y = y; node.renderingOrder = 20
                axis.addChildNode(node)
            }
            overviewOrigin.addChildNode(axis)
            let text = SCNText(string: name, extrusionDepth: 0)
            text.font = .systemFont(ofSize: 1, weight: .bold); text.flatness = 0.1
            text.materials = [material(color)]
            let label = SCNNode(geometry: text); label.name = "model-origin-\(name)-label"
            let (minimum, maximum) = text.boundingBox
            label.pivot = SCNMatrix4MakeTranslation((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, 0)
            label.simdScale = SIMD3(repeating: 0.18); label.simdPosition = direction * 1.15
            label.constraints = [SCNBillboardConstraint()]; label.renderingOrder = 20
            overviewOrigin.addChildNode(label)
        }
        // The node stays at model (0, 0, 0), independent of the model's bounds center or any Pose.
    }

    private func updateOverviewGeometry() {
        let geometry = overviewExpanded ? (sourceGeometry ?? sourceOverview) : sourceOverview
        overviewObject.geometry = geometry.map(Self.copyForInspection)
        modelOriginSwitch.isEnabled = geometry != nil
        overviewOrigin.isHidden = !showsModelOrigin || geometry == nil
        if let bounds = (sourceOverview ?? sourceGeometry)?.boundingBox {
            let extent = SIMD3<Float>(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z)
            let radius = simd_length(extent) / 2
            if radius.isFinite { overviewOrigin.simdScale = SIMD3(repeating: max(radius, 0.05) * 0.25) }
        }
        if let footprint = overviewFootprint, footprint.frameCount > 0 {
            for material in overviewObject.geometry?.materials ?? [] {
                TeachingCoverageRenderer.apply(footprint, opacity: 0.65, to: material)
            }
        }
    }

    @objc private func expandOverview() {
        setOverviewExpanded(true); onOverviewExpansionChange?(overviewExpanded)
    }
    @objc private func collapseOverview() {
        setOverviewExpanded(false); onOverviewExpansionChange?(overviewExpanded)
    }
    @objc private func cameraPoseToggled() {
        setCameraPoseVisible(cameraPoseSwitch.isOn); onCameraPoseVisibilityChange?(showsCameraPose)
    }
    @objc private func modelOriginToggled() {
        setModelOriginVisible(modelOriginSwitch.isOn); onModelOriginVisibilityChange?(showsModelOrigin)
    }

    func setModelOriginVisible(_ visible: Bool) {
        guard visible != showsModelOrigin else { return }
        showsModelOrigin = visible; modelOriginSwitch.setOn(visible, animated: false)
        overviewOrigin.isHidden = !visible || overviewObject.geometry == nil
        updateOverviewAccessibility()
        overviewView.setNeedsDisplay()
    }

    func setCameraPoseVisible(_ visible: Bool) {
        guard visible != showsCameraPose else { return }
        showsCameraPose = visible; cameraPoseSwitch.setOn(visible, animated: false)
        overviewPose.isHidden = !visible || overviewPose.childNodes.isEmpty
        updateOverviewAccessibility()
        overviewView.setNeedsDisplay()
    }

    private func updateOverviewAccessibility() {
        let camera = showsCameraPose ? "相机姿态与投影已显示" : "相机姿态与投影已隐藏"
        let origin = showsModelOrigin ? "模型坐标原点已显示" : "模型坐标原点已隐藏"
        overviewView.accessibilityValue = "\(camera)；\(origin)"
        overviewContainer.accessibilityValue = overviewView.accessibilityValue
    }

    func setOverviewExpanded(_ expanded: Bool) {
        guard expanded != overviewExpanded else { return }
        guard !expanded || (mode == .interactive && overviewObject.geometry != nil) else { return }
        controller.stopInertia(); overviewController.stopInertia()
        overviewExpanded = expanded
        updateOverviewGeometry()
        overviewDoubleTap.isEnabled = !expanded
        overviewView.isUserInteractionEnabled = expanded
        overviewView.isAccessibilityElement = expanded
        overviewCollapseButton.isHidden = !expanded
        cameraPoseControl.isHidden = !expanded
        modelOriginControl.isHidden = !expanded
        overviewContainer.isAccessibilityElement = !expanded
        overviewContainer.accessibilityIdentifier = expanded ? "pose-global-overview-container" : "pose-global-thumbnail"
        sceneView.isUserInteractionEnabled = mode == .interactive && !expanded
        sceneView.isHidden = mode == .image || expanded
        setNeedsLayout(); layoutIfNeeded()
        fitOverviewCamera()
        if mode == .interactive {
            UIAccessibility.post(notification: .layoutChanged, argument: expanded ? overviewCollapseButton : overviewContainer)
        }
    }

    private func orbitLocation(_ gesture: UIPanGestureRecognizer, in view: UIView) -> CGPoint {
        let location = gesture.location(in: view)
        // Reverse vertical tumbling while retaining the horizontal drag direction
        // in both the local preview and the expanded global view.
        return CGPoint(x: location.x, y: view.bounds.height - location.y)
    }

    @objc private func orbitOverview(_ gesture: UIPanGestureRecognizer) {
        guard overviewExpanded else { return }
        let location = orbitLocation(gesture, in: overviewView)
        switch gesture.state {
        case .began: overviewController.beginInteraction(location, withViewport: overviewView.bounds.size)
        case .changed: overviewController.continueInteraction(location, withViewport: overviewView.bounds.size, sensitivity: 1)
        case .ended, .cancelled, .failed:
            overviewController.endInteraction(location, withViewport: overviewView.bounds.size, velocity: .zero)
        default: break
        }
        overviewView.setNeedsDisplay()
    }

    @objc private func panOverview(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .changed else { return }
        translateOverview(by: gesture.translation(in: overviewView))
        gesture.setTranslation(.zero, in: overviewView)
    }

    func translateOverview(by translation: CGPoint) {
        guard overviewExpanded, overviewView.bounds.height > 0 else { return }
        let units = Float(2 * (overviewCamera.camera?.orthographicScale ?? 1) / Double(overviewView.bounds.height))
        let delta = overviewCamera.simdWorldRight * (-Float(translation.x) * units)
            + overviewCamera.simdWorldUp * (Float(translation.y) * units)
        overviewCamera.simdPosition += delta
        let target = overviewController.target
        let shifted = SIMD3<Float>(target.x, target.y, target.z) + delta
        overviewController.target = SCNVector3(shifted.x, shifted.y, shifted.z)
        overviewView.setNeedsDisplay()
    }

    @objc private func pinchOverview(_ gesture: UIPinchGestureRecognizer) {
        guard gesture.state == .changed else { return }
        zoomOverview(by: Double(gesture.scale)); gesture.scale = 1
    }

    func zoomOverview(by scale: Double) {
        guard overviewExpanded, scale.isFinite, scale > 0, let lens = overviewCamera.camera else { return }
        lens.orthographicScale = min(max(lens.orthographicScale / scale, Double(overviewRadius) * 0.015), Double(overviewRadius) * 20)
        overviewView.setNeedsDisplay()
    }

    private func renderRecordedImageIfNeeded() {
        guard mode == .image, recordedObject.geometry != nil, bounds.width > 1, bounds.height > 1 else {
            if recordedObject.geometry == nil { imageView.image = nil }
            return
        }
        // Bound memory even on a Retina iPad; cache only the selected Pose.
        let scale = min((window?.screen.scale ?? 2) * imageDetailScale, 3200 / max(bounds.width, bounds.height))
        let fitted = ZividFieldOfView.fittedFrame(in: bounds.size).size
        let width = max(1, (fitted.width * scale).rounded())
        let size = CGSize(width: width, height: (width / ZividFieldOfView.nativeAspect).rounded())
        guard snapshotDirty || size != snapshotSize else { return }
        let renderer = SCNRenderer(device: sceneView.device, options: nil)
        renderer.scene = recordedScene; renderer.pointOfView = recordedCamera
        imageView.image = renderer.snapshot(atTime: 0, with: size, antialiasingMode: .multisampling4X)
        snapshotSize = size; snapshotDirty = false
    }

    @objc private func orbit(_ gesture: UIPanGestureRecognizer) {
        guard mode == .interactive, !overviewExpanded else { return }
        let location = orbitLocation(gesture, in: sceneView)
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
        guard mode == .interactive, !overviewExpanded, bounds.height > 0 else { return }
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
        guard mode == .interactive, !overviewExpanded, scale.isFinite, scale > 0 else { return }
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
        controller.stopInertia(); overviewController.stopInertia()
        sceneView.isPlaying = false; overviewView.isPlaying = false
        imageScrollView.setContentOffset(imageScrollView.contentOffset, animated: false)
    }
}
