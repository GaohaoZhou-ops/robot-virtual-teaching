import ARKit
import Combine
import QuartzCore
import RealityKit
import UIKit

@MainActor
final class VisionTrackingController: ObservableObject {
    enum SpaceState { case closed, opening, open, closing }
    @Published var spaceState = SpaceState.closed
    @Published private(set) var placement = VisionPlacement()
    @Published private(set) var trackingNormal = false { didSet { if oldValue != trackingNormal { refreshManipulation() } } }
    @Published private(set) var anchorTracked = false { didSet { if oldValue != anchorTracked { refreshManipulation() } } }
    @Published private(set) var preparing = false { didSet { if oldValue != preparing { refreshManipulation() } } }
    @Published private(set) var calibrating = false { didSet { if oldValue != calibrating { refreshManipulation() } } }
    @Published private(set) var planeCount = 0
    @Published private(set) var message = "进入空间后，选择水平面放置模型"
    @Published private(set) var tracking = "尚未进入空间"
    @Published private(set) var renderSummary = ""
    @Published private(set) var renderStatus = ""
    @Published private(set) var renderError = ""
    @Published private(set) var isDemo = false
    @Published private(set) var modelEntity: ModelEntity?
    @Published var showFrustum = true { didSet { cameraFrustum.isEnabled = showFrustum } }
    @Published private(set) var cameraTarget: VisionCameraTarget?
    @Published private(set) var cameraImage: UIImage?
    @Published private(set) var cameraPreviewError = ""
    @Published private(set) var targetCommit = 0
    @Published private(set) var selectedSampleID: String?
    @Published private(set) var isManipulating = false
    @Published private(set) var canUndoTarget = false
    var keepFocus: Bool { cameraTarget?.focusLocked ?? false }
    var readOnly = false
    let cameraRig = Entity()
    let cameraFrustum = Entity()
    let focusMarker = ModelEntity(mesh: .generateSphere(radius: 0.012), materials: [UnlitMaterial(color: .systemMint)])
    var targetHistory = VisionTargetHistory()
    var gestureTarget: VisionCameraTarget?
    var gesturePlacement: simd_float4x4?
    var recordedSamples: [TeachingSample] = []
    var previewEngine = VisionCameraPreview()
    var previewPrepareTask: Task<Void, Never>?
    var previewTask: Task<Void, Never>?
    var sceneSubscriptions: [any Cancellable] = []
    var previewGeneration = UUID()
    var surfacePickError = ""
    @Published var quality = VisionQuality.light
    @Published var displayMode = ModelDisplayMode.mesh
    let root = Entity()
    let objectRoot = Entity()
    // Only this hierarchy participates in the immersive placement gesture.
    let planesRoot = Entity()
    private var markers: Entity?
    private var arSession: ARKitSession?
    private var world: WorldTrackingProvider?
    private var anchorID: UUID?
    private var tasks: [Task<Void, Never>] = []
    private var renderTask: Task<Void, Never>?
    private var generation = UUID()
    private var renderGeneration = UUID()
    private var running = false
    private var activeSpaceID: UUID?
    private var editSnapshot: VisionPlacement?
    private var planeEntities: [UUID: Entity] = [:]
    private var planeMeshes: [UUID: (vertices: [SIMD3<Float>], indices: [UInt32])] = [:]
    private var simulatedDevice = matrix_identity_float4x4

    var canRecord: Bool {
        canEditTarget && cameraTarget != nil && !isManipulating
    }
    var canEditTarget: Bool { running && trackingNormal && placement.isCalibrated && anchorTracked && !preparing && !calibrating && renderError.isEmpty && !readOnly }
    var canCancelAdjustment: Bool { editSnapshot != nil }

    init() {
        root.addChild(objectRoot); root.addChild(planesRoot)
        objectRoot.addChild(VisionModelRenderer.axes()); objectRoot.isEnabled = false
        buildCameraRig()
    }

    func configure(_ model: ModelGeometry, samples: [TeachingSample], demo: Bool, draft: SpatialCameraDraft? = nil, readOnly: Bool = false) {
        stop(); isDemo = demo; editSnapshot = nil
        self.readOnly = readOnly; cameraTarget = draft.flatMap { try? VisionCameraTarget(draft: $0) }
        selectedSampleID = nil; targetHistory.clear(); canUndoTarget = false; cameraImage = nil
        previewPrepareTask?.cancel(); previewTask?.cancel(); cameraPreviewError = ""
        let engine = VisionCameraPreview(); previewEngine = engine
        previewPrepareTask = Task { do { try await engine.prepare(model) } catch { if !Task.isCancelled { cameraPreviewError = "取景预览暂不可用" } } }
        modelEntity?.removeFromParent(); modelEntity = nil
        placement = VisionPlacement(reference: SIMD3((model.minimum.x + model.maximum.x) / 2,
            (model.minimum.y + model.maximum.y) / 2, model.minimum.z))
        refreshMarkers(samples)
        render(model)
    }

    func render(_ model: ModelGeometry) {
        renderTask?.cancel(); renderGeneration = UUID()
        let generation = renderGeneration, mode = displayMode, quality = quality
        preparing = true; renderError = ""
        renderStatus = "正在准备\(quality.label)\(mode.label)…"
        renderTask = Task {
            let build = Task.detached(priority: .userInitiated) { try VisionMeshData(model: model, mode: mode, quality: quality) }
            do {
                let data = try await withTaskCancellationHandler(operation: { try await build.value }, onCancel: { build.cancel() })
                try Task.checkCancellation()
                let unit = data.isMesh ? "面" : "点"
                renderStatus = "正在加载\(quality.label) · \(data.primitiveCount.formatted()) \(unit)…"
                let entity = try await VisionModelRenderer.makeEntity(data)
                guard !Task.isCancelled, generation == renderGeneration else { return }
                modelEntity?.removeFromParent(); modelEntity = entity; objectRoot.addChild(entity)
                entity.name = "atlas-workpiece"
                entity.components.set(VisionSurfaceTarget())
                entity.components.set(InputTargetComponent())
                do {
                    let shape = try await ShapeResource.generateStaticMesh(from: entity.model!.mesh)
                    guard !Task.isCancelled, generation == renderGeneration else { return }
                    entity.components.set(CollisionComponent(shapes: [shape], mode: .trigger))
                    surfacePickError = ""
                } catch { surfacePickError = "表面点选暂不可用，可直接抓取相机" }
                configurePlacementManipulation(model)
                let total = data.isMesh ? model.indices / 3 : model.vertices
                renderSummary = "\(data.isMesh ? "Mesh" : "点云") · \(quality.label) · \(data.primitiveCount.formatted()) / \(total.formatted()) \(unit) · 1:1"
                preparing = false; renderStatus = ""
            } catch {
                guard !Task.isCancelled, generation == renderGeneration else { return }
                renderError = "模型显示失败：\(error.localizedDescription)"; preparing = false; renderStatus = ""
            }
        }
    }

    func start() async {
        guard !running else { return }
        generation = UUID(); let token = generation
        running = true
        #if targetEnvironment(simulator)
        if isDemo {
            simulatedDevice = matrix_identity_float4x4
            simulatedDevice.columns.3 = SIMD4(0, 1.6, 0, 1)
            trackingNormal = true; tracking = "模拟演练 · 不可同步"
            message = "点击「放到前方」演练放置、校准和记录流程"
            return
        }
        running = false; tracking = "模拟器不提供真实采样"
        message = "请使用本地演练测试空间流程；配对任务需在 Vision Pro 真机上记录"
        #else
        guard WorldTrackingProvider.isSupported else {
            running = false; tracking = "当前环境不支持头显定位"
            message = "模拟器可使用本地演练；真实示教需要 Vision Pro 真机"; return
        }
        let session = ARKitSession(), provider = WorldTrackingProvider()
        arSession = session; world = provider
        tracking = "正在启动空间定位"
        tasks.append(Task { [weak self] in
            for await event in session.events {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                switch event {
                case .authorizationChanged(let type, let status):
                    if type == .worldSensing && status == .denied {
                        self.clearPlanes(); self.message = "未允许空间感知，可使用「放到前方」手动放置"
                    }
                case .dataProviderStateChanged(let providers, let state, let error):
                    if error != nil || (providers.contains(where: { $0 is WorldTrackingProvider }) && (state == .paused || state == .stopped)) {
                        self.invalidatePlacement()
                        self.tracking = error == nil ? "空间定位已中断" : "空间定位失败"
                        self.message = "请退出并重新进入空间，再校准模型；已有 Pose 已保留"
                    }
                @unknown default: break
                }
            }
        })
        do {
            var providers: [any DataProvider] = [provider]
            var planeProvider: PlaneDetectionProvider?
            if PlaneDetectionProvider.isSupported {
                let authorization = await session.requestAuthorization(for: [.worldSensing])
                guard generation == token, !Task.isCancelled else { return }
                if authorization[.worldSensing] == .allowed {
                    let planes = PlaneDetectionProvider(alignments: [.horizontal])
                    providers.append(planes); planeProvider = planes
                } else { message = "未允许空间感知，可使用「放到前方」手动放置" }
            }
            try await session.run(providers)
            guard generation == token, !Task.isCancelled else { session.stop(); return }
            tasks.append(Task { [weak self] in
                for await update in provider.anchorUpdates {
                    guard let self, self.generation == token, !Task.isCancelled else { return }
                    guard update.anchor.id == self.anchorID else {
                        // Anchors from a prior launch are never used without a new calibration.
                        if update.event == .added { try? await provider.removeAnchor(forID: update.anchor.id) }
                        continue
                    }
                    if update.event == .removed {
                        self.invalidatePlacement(); self.message = "模型空间锚点已失效，请重新放置"
                    } else {
                        self.anchorTracked = update.anchor.isTracked
                        if update.anchor.isTracked {
                            self.placement.refine(update.anchor.originFromAnchorTransform)
                            self.updateObject()
                        }
                    }
                }
            })
            if let planes = planeProvider {
                tasks.append(Task { [weak self] in
                    for await update in planes.anchorUpdates {
                        guard let self, self.generation == token, !Task.isCancelled else { return }
                        if update.event == .removed {
                            self.planeEntities.removeValue(forKey: update.anchor.id)?.removeFromParent()
                            self.planeMeshes.removeValue(forKey: update.anchor.id)
                            self.planeCount = self.planeEntities.count
                        } else { await self.updatePlane(update.anchor, token: token) }
                    }
                })
            }
            tasks.append(Task { [weak self] in
                while !Task.isCancelled {
                    guard let self, self.generation == token else { return }
                    self.updateDevice()
                    do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                }
            })
        } catch {
            guard generation == token else { return }
            stop(); tracking = "无法启动空间定位"; message = error.localizedDescription
        }
        #endif
    }

    func spaceAppeared(_ id: UUID) async {
        guard activeSpaceID != id else { return }
        stop(); activeSpaceID = id; spaceState = .open
        await start()
    }
    func spaceDisappeared(_ id: UUID) {
        guard activeSpaceID == id else { return }
        stop(); activeSpaceID = nil; spaceState = .closed
    }

    func stop() {
        cancelTargetGesture()
        generation = UUID(); running = false
        tasks.forEach { $0.cancel() }; tasks.removeAll()
        let oldSession = arSession, oldWorld = world, oldAnchor = anchorID
        arSession = nil; world = nil; anchorID = nil
        // Release only this app's anchor; don't carry calibration across immersive sessions.
        Task {
            if let oldWorld, let oldAnchor { try? await oldWorld.removeAnchor(forID: oldAnchor) }
            oldSession?.stop()
        }
        invalidatePlacement(); clearPlanes(); tracking = "尚未进入空间"
        sceneSubscriptions.forEach { $0.cancel() }; sceneSubscriptions.removeAll(); cameraRig.isEnabled = false; focusMarker.isEnabled = false
    }

    func invalidatePlacement() {
        trackingNormal = false; anchorTracked = false; calibrating = false
        cancelTargetGesture()
        placement = VisionPlacement(reference: placement.reference)
        editSnapshot = nil; objectRoot.isEnabled = false; planesRoot.isEnabled = true
        refreshManipulation()
    }

    private func deviceTransform() -> simd_float4x4? {
        guard running else { return nil }
        #if targetEnvironment(simulator)
        if isDemo { return simulatedDevice }
        #endif
        guard let world, world.state == .running,
              let anchor = world.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), anchor.isTracked,
              VisionPoseMath.isRigid(anchor.originFromAnchorTransform) else { return nil }
        return anchor.originFromAnchorTransform
    }

    private func updateDevice() {
        guard let transform = deviceTransform() else {
            trackingNormal = false; tracking = "正在恢复头显定位"; return
        }
        trackingNormal = true; tracking = placement.isCalibrated && !anchorTracked ? "等待模型锚点定位" : "空间定位正常"
    }

    func placeInFront() {
        guard !placement.isCalibrated, !calibrating, let device = deviceTransform() else { return }
        place(at: (device * SIMD4(0, -0.55, -1.6, 1)).xyz)
        message = "捏住工件移动或转动，满意后确认摆放"
    }
    func placeOnObservedSurface() {
        guard let device = deviceTransform(), !placement.isCalibrated, !calibrating else { return }
        let origin = device.translation, direction = -device.columns.2.xyz
        let points = planeMeshes.values.compactMap {
            VisionPoseMath.intersection(origin: origin, direction: direction, vertices: $0.vertices, indices: $0.indices)
        }
        guard let hit = points.min(by: { simd_distance(origin, $0) < simd_distance(origin, $1) }) else {
            message = "头部朝向未命中已识别的水平面，请看向青色区域后重试"; return
        }
        place(at: hit)
    }
    func place(at position: SIMD3<Float>) {
        guard !placement.isCalibrated, !calibrating, deviceTransform() != nil,
              (0..<3).allSatisfy({ position[$0].isFinite }) else { return }
        placement.hit = position; updateObject()
        refreshManipulation()
        message = "捏住工件移动或转动，满意后确认摆放"
    }
    func beginAdjustment() {
        guard placement.isCalibrated, !calibrating, !isManipulating else { return }
        editSnapshot = placement
        placement.unlock(); planesRoot.isEnabled = true
        cameraRig.isEnabled = false; focusMarker.isEnabled = false; refreshManipulation()
        message = "调整完成后重新确认校准，已有 Pose 保持原模型坐标"
    }
    func cancelAdjustment() {
        guard let snapshot = editSnapshot, !calibrating else { return }
        placement = snapshot; editSnapshot = nil; planesRoot.isEnabled = false; updateObject()
        refreshManipulation(); refreshTarget()
        #if targetEnvironment(simulator)
        anchorTracked = isDemo
        #else
        anchorTracked = false
        let token = generation, calibrationID = snapshot.calibration?.id
        guard let provider = world, let id = anchorID else { return }
        tasks.append(Task {
            let anchors = await provider.allAnchors
            guard generation == token, placement.calibration?.id == calibrationID,
                  let anchor = anchors?.first(where: { $0.id == id }), anchor.isTracked else { return }
            placement.refine(anchor.originFromAnchorTransform); anchorTracked = true; updateObject()
        })
        #endif
    }
    func confirm() async throws -> Calibration {
        guard !calibrating, !placement.isCalibrated, !preparing, renderError.isEmpty, deviceTransform() != nil else {
            throw TeachingError("请等待模型和空间定位就绪")
        }
        calibrating = true
        let token = generation
        defer { if generation == token { calibrating = false } }
        let calibration = try placement.confirm()
        #if targetEnvironment(simulator)
        if isDemo { anchorTracked = true; editSnapshot = nil; planesRoot.isEnabled = false; placementConfirmed(); return calibration }
        #endif
        guard let world else { placement.unlock(); throw TeachingError("空间定位尚未启动") }
        let oldID = anchorID
        let anchor = WorldAnchor(originFromAnchorTransform: simd_float4x4(elements: calibration.worldFromModel))
        anchorID = anchor.id; anchorTracked = false
        do {
            try await world.addAnchor(anchor)
            guard generation == token, running, placement.calibration?.id == calibration.id else {
                try? await world.removeAnchor(forID: anchor.id)
                throw CancellationError()
            }
            if let oldID { try? await world.removeAnchor(forID: oldID) }
            guard generation == token else { throw CancellationError() }
            editSnapshot = nil; planesRoot.isEnabled = false
            placementConfirmed()
            return calibration
        } catch {
            if generation == token { placement.unlock(); anchorID = oldID; anchorTracked = false }
            throw error
        }
    }
    func capture() throws -> TeachingSample {
        guard canRecord, let target = cameraTarget,
              let calibration = placement.calibration else { throw TeachingError("请先确认校准，并等待头显与模型定位正常") }
        return try target.sample(segmentID: calibration.id)
    }
    func refreshMarkers(_ samples: [TeachingSample]) {
        recordedSamples = samples
        if let id = selectedSampleID, !samples.contains(where: { $0.id == id }) { selectedSampleID = nil }
        markers?.removeFromParent(); let entity = VisionModelRenderer.markers(samples)
        markers = entity; objectRoot.addChild(entity)
    }
    func updateObject() {
        guard let transform = placement.transform else { objectRoot.isEnabled = false; return }
        objectRoot.transform = Transform(matrix: transform); objectRoot.isEnabled = true
    }

    func setCameraTarget(_ target: VisionCameraTarget?, selectedID: String? = nil, commit: Bool = true) {
        let lockChanged = cameraTarget?.focusLocked != target?.focusLocked
        cameraTarget = target; selectedSampleID = selectedID
        if commit { targetCommit += 1 }
        canUndoTarget = !targetHistory.entries.isEmpty
        refreshTarget()
        if lockChanged && !isManipulating { refreshManipulation() }
    }
    func setGestureActive(_ active: Bool) { isManipulating = active }
    func setCameraPreview(_ image: UIImage?) { cameraImage = image }
    func targetMessage(_ value: String) { message = value }
    func applyPlacementGesture(_ matrix: simd_float4x4) { placement.moveDraft(to: matrix); updateObject() }
    func modelDeviceTransform() -> simd_float4x4? {
        guard let model = placement.transform, let device = deviceTransform() else { return nil }
        return model.inverse * device
    }
    private func clearPlanes() {
        planeEntities.values.forEach { $0.removeFromParent() }; planeEntities.removeAll(); planeMeshes.removeAll(); planeCount = 0
    }
    private func updatePlane(_ anchor: PlaneAnchor, token: UUID) async {
        guard anchor.alignment == .horizontal else { return }
        let source = anchor.geometry.meshVertices, faces = anchor.geometry.meshFaces
        guard source.format == .float3, faces.primitive == .triangle else { return }
        let positions = (0..<source.count).map { index in
            let pointer = source.buffer.contents().advanced(by: source.offset + index * source.stride)
            return SIMD3(pointer.loadUnaligned(as: Float.self), pointer.advanced(by: 4).loadUnaligned(as: Float.self),
                pointer.advanced(by: 8).loadUnaligned(as: Float.self))
        }
        let indices: [UInt32] = (0..<(faces.count * 3)).map { index in
            let pointer = faces.buffer.contents().advanced(by: index * faces.bytesPerIndex)
            return faces.bytesPerIndex == 2 ? UInt32(pointer.loadUnaligned(as: UInt16.self)) : pointer.loadUnaligned(as: UInt32.self)
        }
        guard !positions.isEmpty, !indices.isEmpty, indices.allSatisfy({ $0 < positions.count }) else { return }
        do {
            var descriptor = MeshDescriptor(name: "Observed horizontal surface")
            descriptor.positions = MeshBuffers.Positions(positions); descriptor.primitives = .triangles(indices)
            let mesh = try await MeshResource(from: [descriptor])
            let shape = try await ShapeResource.generateStaticMesh(from: mesh)
            guard generation == token, !Task.isCancelled else { return }
            var material = UnlitMaterial(color: .systemCyan)
            material.blending = .transparent(opacity: .init(floatLiteral: 0.18)); material.faceCulling = .none
            let entity = ModelEntity(mesh: mesh, materials: [material])
            entity.name = "atlas-surface"
            entity.transform = Transform(matrix: anchor.originFromAnchorTransform)
            entity.components.set(CollisionComponent(shapes: [shape], mode: .trigger))
            entity.components.set(InputTargetComponent())
            entity.components.set(HoverEffectComponent())
            planeEntities.removeValue(forKey: anchor.id)?.removeFromParent()
            planesRoot.addChild(entity); planeEntities[anchor.id] = entity; planeCount = planeEntities.count
            planeMeshes[anchor.id] = (positions.map { (anchor.originFromAnchorTransform * SIMD4($0, 1)).xyz }, indices)
        } catch { if !Task.isCancelled { message = "水平面显示暂不可用，可手动放到前方" } }
    }

    #if targetEnvironment(simulator)
    func moveDemo() {
        guard isDemo else { return }
        simulatedDevice.columns.3.x += 0.2
    }
    #endif
}
