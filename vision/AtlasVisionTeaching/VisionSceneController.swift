import SwiftUI
import RealityKit
import ARKit
import Combine
import QuartzCore

struct VisionSceneSelection: Component { var nodeID: String; var name: String; var taskID: String? = nil; var role: String = "object" }

@MainActor final class VisionSceneController: ObservableObject {
    @Published private(set) var manifest: VisionSceneManifest?
    @Published private(set) var busy = false
    @Published var status = ""
    @Published var error = ""
    @Published var immersed = false
    @Published var cameraWindowVisible = false
    @Published private(set) var playing = false
    @Published private(set) var progress = 0.0
    @Published private(set) var clipIndex: Int?
    @Published private(set) var lifeSize = false
    @Published private(set) var selection = ""
    @Published private(set) var measurement: Float?
    @Published private(set) var immersiveProject = false
    @Published private(set) var destination: SIMD3<Float>?
    @Published private(set) var travelling = false
    @Published var measuring = false
    @Published private(set) var navigationMessage = ""
    @Published private(set) var arrivedParkingPoint: VisionSceneMarker?
    @Published private(set) var placingProject = false
    @Published private(set) var proximityPassthrough = true
    @Published private(set) var proximityMessage = ""
    @Published var floorGridVisible = true { didSet { floorGrid?.isEnabled = floorGridVisible } }
    @Published private(set) var floorGridSpacing: Float = 1
    @Published var parkingLabelsVisible = UserDefaults.standard.object(forKey: "visionParkingLabelsVisible") as? Bool ?? true {
        didSet {
            parkingLabels?.isEnabled = parkingLabelsVisible
            UserDefaults.standard.set(parkingLabelsVisible, forKey: "visionParkingLabelsVisible")
        }
    }
    var requiresPassthrough: Bool { placingProject || proximityPassthrough }
    #if targetEnvironment(simulator)
    @Published var simulatedObstacleDistance: Float = 3
    #endif
    let root = Entity(), stage = Entity(), axes = Entity(), content = Entity(), annotation = Entity()
    private let landing = Entity(), environment = Entity(), lighting = Entity()
    private var floorGrid: Entity?
    private var parkingLabels: Entity?
    private var parkingMarkers: [VisionSceneMarker] = []
    private var parkingEntities: [String: ModelEntity] = [:]
    private var parkingArrivalHalo: ModelEntity?
    private var parkingArrivalPhase = 0.0
    private let mapGroup = CollisionGroup(rawValue: 1 << 4)
    private let robotGroup = CollisionGroup(rawValue: 1 << 5)
    private var travelTask: Task<Void, Never>?
    private var entryPoint: SIMD3<Float>?
    private var referenceFloorBounds: (low: SIMD3<Float>, high: SIMD3<Float>)?
    private var entities: [String: Entity] = [:]
    private var meshes: [String: ModelEntity] = [:]
    private var mapDetails = Set<String>()
    private var subscriptions: [EventSubscription] = []
    private let groundTracking = VisionGroundTracking()
    private var physicalFloorHeight: Float { groundTracking.floorHeight }
    private var positioned = false
    private var generation = UUID()
    private var detailTask: Task<Void, Never>?
    private var detailRequest = Set<String>()
    private var detailRevision = UUID()
    private var time = 0.0, lastDetail = 0.0, lastUI = 0.0
    private var mapLightDirection: SIMD3<Float>?
    private var firstPoint: SIMD3<Float>?
    private var focusPoint: SIMD3<Float>?
    private var obstacleFade = VisionObstacleFade()
    private var passthroughVisible = false
    private var obstacleOpacity: Float = -1
    var clip: VisionSceneClip? { clipIndex.flatMap { manifest?.clips.indices.contains($0) == true ? manifest?.clips[$0] : nil } }
    var hasClips: Bool { manifest?.clips.isEmpty == false }
    var hasCameras: Bool { manifest?.cameraNodes.isEmpty == false }

    func cameraSnapshot() -> VisionSceneCameraSnapshot? {
        guard immersed, !busy, let manifest else { return nil }
        let cameraIDs = Set(manifest.cameraNodes.values)
        let nodes = manifest.nodes.filter { ($0.role == "map" && $0.asset != nil) || cameraIDs.contains($0.id) }
        return VisionSceneCameraSnapshot(transforms: Dictionary(uniqueKeysWithValues: nodes.compactMap { node in
            entities[node.id].map { (node.id, $0.transformMatrix(relativeTo: content)) }
        }))
    }

    init() {
        VisionSceneSelection.registerComponent()
        VisionRecallTarget.registerComponent()
        root.addChild(stage); stage.addChild(axes); axes.addChild(content)
        axes.transform = Transform(matrix: TeachingCoordinates.zUpToAR)
        axes.addChild(lighting)
        content.addChild(annotation); content.addChild(landing); root.addChild(environment)
        root.addChild(groundTracking.surfacesRoot)
        groundTracking.onScanning = { [weak self] scanning in
            guard let self else { return }
            self.placingProject = scanning
            if scanning {
                self.setParkingArrival(nil)
                self.resetObstacleFade()
                self.lifeSize = false
                self.positioned = false; self.stage.isEnabled = false; self.environment.isEnabled = false
                self.root.components.set(OpacityComponent(opacity: 1))
            }
        }
        groundTracking.onPlacement = { [weak self] transform in self?.applyGroundPlacement(transform) }
        groundTracking.onAnchorMotion = { [weak self] delta in
            guard let self else { return }
            // Preserve sandbox/locomotion offsets if ARKit refines its origin.
            self.stage.transform = Transform(matrix: delta * self.stage.transform.matrix)
        }
        groundTracking.onMessage = { [weak self] message in self?.navigationMessage = message }
    }
    func prepare(_ scene: VisionSceneManifest, immersiveProject: Bool = false) async throws {
        stop(); generation = UUID(); let token = generation
        self.immersiveProject = immersiveProject; lifeSize = false; measuring = false; entryPoint = nil
        placingProject = immersiveProject; stage.isEnabled = !immersiveProject; environment.isEnabled = !immersiveProject
        referenceFloorBounds = nil; floorGrid = nil; floorGridSpacing = 1; parkingLabels = nil
        parkingMarkers = []; parkingEntities.removeAll(); parkingArrivalHalo = nil
        root.components.set(OpacityComponent(opacity: 1)); environment.children.forEach { $0.removeFromParent() }
        busy = true; error = ""; defer { busy = false }
        try scene.validate(); manifest = scene; clipIndex = nil; time = 0; progress = 0
        entities.removeAll(); meshes.removeAll(); mapDetails.removeAll(); clearSelection()
        mapLightDirection = nil
        content.children.filter { $0 !== annotation && $0 !== landing }.forEach { $0.removeFromParent() }
        clearDestination()
        let assets = Dictionary(uniqueKeysWithValues: scene.assets.map { ($0.id, $0) })
        do {
            if scene.robotRoot != nil { try await VisionSurfaceRenderer.configureLighting(lighting) }
            for (index, node) in scene.nodes.enumerated() {
                try Task.checkCancellation(); guard token == generation else { throw CancellationError() }
                status = "装配空间内容 \(index + 1) / \(scene.nodes.count)"
                let entity = Entity(); entity.name = node.name; entity.transform = Transform(matrix: simd_float4x4(elements: node.transform))
                (node.parent.flatMap { entities[$0] } ?? content).addChild(entity); entities[node.id] = entity
                if let assetID = node.asset, let asset = assets[assetID] {
                    let mesh = try await makeMesh(asset, node: node, detailed: node.role != "map")
                    guard token == generation else { throw CancellationError() }
                    entity.addChild(mesh); meshes[node.id] = mesh
                }
                if let joint = node.joint { applyJoint(joint, value: joint.value, to: entity) }
            }
            let extent = SIMD3(scene.bounds.max) - SIMD3(scene.bounds.min), width = max(0.006, simd_length(extent) / 1800)
            content.addChild(try await VisionScenePaths.make(scene.paths, width: width))
            let markerRadius = max(0.025, simd_length(extent) / 600)
            let markerMesh = MeshResource.generateSphere(radius: markerRadius)
            for marker in scene.markers {
                let entity = ModelEntity(mesh: markerMesh, materials: [VisionSceneMarkers.material(for: marker)])
                entity.position = SIMD3(marker.position); entity.name = marker.name
                entity.components.set(VisionSceneSelection(nodeID: marker.id, name: marker.name, taskID: marker.taskId, role: "marker"))
                entity.generateCollisionShapes(recursive: false); entity.components.set(InputTargetComponent()); entity.components.set(HoverEffectComponent())
                if #available(visionOS 26.0, *) { entity.components.set(ManipulationComponent.HitTarget(redirectedEntity: stage)) }
                content.addChild(entity)
                if marker.kind == "parking" { parkingMarkers.append(marker); parkingEntities[marker.id] = entity }
            }
            let labels = try await VisionParkingLabels.make(scene.markers, markerRadius: markerRadius)
            guard token == generation, !Task.isCancelled else { throw CancellationError() }
            parkingLabels = labels; labels.isEnabled = parkingLabelsVisible; content.addChild(labels)
            if immersiveProject {
                if !parkingMarkers.isEmpty {
                    let halo = try await VisionParkingArrival.makeIndicator(markerRadius: markerRadius)
                    guard token == generation, !Task.isCancelled else { throw CancellationError() }
                    parkingArrivalHalo = halo; content.addChild(halo)
                }
                addEnvironment(scene)
                let ground = groundHeight(scene)
                let grid = try await VisionFloorGrid.make(low: SIMD3(scene.bounds.min), high: SIMD3(scene.bounds.max), ground: ground)
                guard token == generation, !Task.isCancelled else { throw CancellationError() }
                floorGrid = grid.entity; floorGridSpacing = grid.spacing
                grid.entity.isEnabled = floorGridVisible; content.addChild(grid.entity)
            }
            configureManipulation(); status = immersiveProject ? "进入后自动识别地面；多个候选时注视并捏合选择" : "双手捏住沙盘缩放和旋转；双击局部进入原大查看"
        } catch {
            content.children.filter { $0 !== annotation && $0 !== landing }.forEach { $0.removeFromParent() }
            manifest = nil; entities.removeAll(); meshes.removeAll(); throw error
        }
    }
    private func groundHeight(_ scene: VisionSceneManifest) -> Float {
        scene.navigationGroundHeight
            ?? scene.robotRoot.flatMap { entities[$0]?.position(relativeTo: content).z }
            ?? scene.bounds.min[2]
    }
    private func makeMesh(_ asset: VisionSceneAsset, node: VisionSceneNode, detailed: Bool) async throws -> ModelEntity {
        let model = try await VisionSceneStore.shared.model(asset)
        let count = max(1, manifest?.nodes.filter { $0.role == "map" }.count ?? 1)
        // Keep every triangle in immersive projects. Reducing a floor to dots
        // would also remove its continuous surface from navigation queries.
        let budget = detailed || (immersiveProject && model.indices > 0) ? Int.max : max(512, 240000 / count)
        let useMesh = model.indices > 0 && (detailed || model.indices / 3 <= budget)
        let extent = SIMD3<Float>(model.maximum.x - model.minimum.x, model.maximum.y - model.minimum.y, model.maximum.z - model.minimum.z)
        let radius = detailed ? Float(0.002) : max(0.002, simd_length(extent) / 180)
        let surface: VisionSceneMaterial? = node.role == "part" ? node.material ?? .robotDefault : nil
        let mapSurface = node.role == "map" && useMesh
        let data = try await Task.detached(priority: .userInitiated) {
            try VisionMeshData(model: model, mode: useMesh ? .mesh : .points, quality: .full, pointRadius: radius,
                               primitiveBudget: budget, includeNormals: surface != nil || mapSurface)
        }.value
        try Task.checkCancellation()
        let entity = try await VisionSurfaceRenderer.makeEntity(data, surface: surface, mapSurface: mapSurface)
        if mapSurface, let direction = mapLightDirection { VisionSurfaceRenderer.updateMapLight(entity, direction: direction) }
        if surface != nil { entity.components.set(ImageBasedLightReceiverComponent(imageBasedLight: lighting)) }
        entity.components.set(VisionSceneSelection(nodeID: node.id, name: node.name, role: node.role))
        entity.components.set(InputTargetComponent()); entity.components.set(HoverEffectComponent())
        let shape = try await ShapeResource.generateStaticMesh(from: entity.model!.mesh)
        entity.components.set(CollisionComponent(shapes: [shape], mode: .trigger,
            filter: CollisionFilter(group: node.role == "map" ? mapGroup : robotGroup, mask: .all)))
        if #available(visionOS 26.0, *), !lifeSize { entity.components.set(ManipulationComponent.HitTarget(redirectedEntity: stage)) }
        return entity
    }
    func begin(in scene: RealityViewContent) async {
        immersed = true; positioned = false
        let token = generation
        await groundTracking.start(detectFloor: immersiveProject)
        guard token == generation, immersed, !Task.isCancelled else { return }
        if !immersiveProject { overview() }
        if !Task.isCancelled {
            subscriptions.append(scene.subscribe(to: SceneEvents.Update.self) { [weak self] event in
                Task { @MainActor in self?.update(delta: event.deltaTime) }
            })
            if #available(visionOS 26.0, *) {
                subscriptions.append(scene.subscribe(to: ManipulationEvents.WillEnd.self, on: stage) { [weak self] _ in
                    Task { @MainActor in
                        guard let self else { return }
                        let scale = min(1, max(0.0001, self.stage.scale.x))
                        self.stage.scale = SIMD3(repeating: scale)
                        // Scaling a miniature to 1:1 does not choose a valid
                        // standing position. Enter only through a landing.
                        self.lifeSize = !self.immersiveProject && abs(scale - 1) < 0.02
                        if !self.lifeSize { self.refreshDetail(at: nil) }
                    }
                })
            }
        }
    }
    func stop() {
        playing = false; immersed = false; positioned = false; generation = UUID()
        travelTask?.cancel(); travelTask = nil; travelling = false
        detailTask?.cancel(); detailTask = nil
        subscriptions.forEach { $0.cancel() }; subscriptions.removeAll()
        groundTracking.stop(); placingProject = false
        setParkingArrival(nil)
        resetObstacleFade()
    }
    func immersionChanged(_ amount: Double?) { passthroughVisible = amount.map { $0 < 0.01 } ?? false }
    private func resetObstacleFade() {
        obstacleFade = VisionObstacleFade(); proximityPassthrough = true; proximityMessage = ""
        obstacleOpacity = -1
        stage.components.set(OpacityComponent(opacity: 1)); environment.components.set(OpacityComponent(opacity: 1))
    }
    private func device() -> simd_float4x4? { groundTracking.device() }
    private func applyGroundPlacement(_ transform: simd_float4x4) {
        content.position = .zero
        stage.transform = Transform(matrix: transform)
        stage.isEnabled = true; environment.isEnabled = immersiveProject
        root.components.set(OpacityComponent(opacity: 1))
        lifeSize = true; positioned = true; clearDestination(); configureManipulation(); refreshDetail(at: .zero)
    }
    func alignProjectToFloor() {
        guard immersed, immersiveProject else { return }
        travelTask?.cancel(); travelling = false; playing = false; measuring = false
        clearSelection(); clearDestination(); groundTracking.beginPlacement()
    }
    func selectFloor(_ id: UUID) { groundTracking.select(id) }
    private func placeStage(scale: Float, focus: SIMD3<Float>, vertical: Float) {
        var view = device() ?? matrix_identity_float4x4
        if device() == nil { view.columns.3 = SIMD4(0, 1.6, 0, 1) }
        var forward = -view.columns.2.xyz; forward.y = 0
        forward = simd_length(forward) > 0.01 ? simd_normalize(forward) : SIMD3(0, 0, -1)
        stage.transform = Transform(scale: SIMD3(repeating: scale), rotation: simd_quatf(from: SIMD3(0, 0, -1), to: forward),
            translation: view.translation + forward * 1.5 + SIMD3(0, vertical, 0))
        content.position = -focus; positioned = device() != nil
        configureManipulation()
    }
    func overview() {
        guard let scene = manifest else { return }
        setParkingArrival(nil)
        groundTracking.cancelPlacement(); stage.isEnabled = true
        travelTask?.cancel(); travelling = false; root.components.set(OpacityComponent(opacity: 1)); clearDestination()
        let low = SIMD3(scene.bounds.min), high = SIMD3(scene.bounds.max), size = high - low
        placeStage(scale: min(0.7, max(0.0001, 1.4 / max(size.x, size.y, size.z, 0.1))), focus: SIMD3((low.x + high.x) / 2, (low.y + high.y) / 2, low.z), vertical: -0.45)
        lifeSize = false; environment.isEnabled = immersiveProject; configureManipulation(); refreshDetail(at: nil)
        if immersiveProject { positioned = true }
        navigationMessage = "双手捏住沙盘缩放、转动；点选地面后进入该位置"
    }
    func detail(at point: SIMD3<Float>? = nil) {
        if immersiveProject {
            if let point { proposeDestination(point); return }
            enterProject(); return
        }
        guard let scene = manifest else { return }
        let robotOrigin = scene.robotRoot.flatMap { entities[$0]?.position(relativeTo: content) }
        let target = point ?? focusPoint ?? robotOrigin ?? .zero
        // Keep the map floor below the observer. Centering a robot's base at
        // eye height would put its entire floor in front of the control panel.
        let eyeHeight = max(0.8, (device()?.translation.y ?? 1.6) - physicalFloorHeight)
        let ground = groundHeight(scene)
        let vertical = min(-0.15, target.z - ground - eyeHeight)
        focusPoint = target; placeStage(scale: 1, focus: target, vertical: vertical); lifeSize = true
        refreshDetail(at: target)
    }
    private func addEnvironment(_ scene: VisionSceneManifest) {
        let sky = ModelEntity(mesh: .generateSphere(radius: 500), materials: [UnlitMaterial(color: UIColor(red: 0.035, green: 0.055, blue: 0.065, alpha: 1))])
        sky.components.set(DynamicLightShadowComponent(castsShadow: false))
        sky.scale = SIMD3(-1, 1, 1); environment.addChild(sky)
        // Sparse point clouds and isolated workpieces have no continuous floor.
        // A point-cloud map can also contain placed mesh models; it still needs
        // a continuous reference plane below its navigation/parking points.
        if scene.hasPointCloudMap || scene.coordinateFrame == "virtual_origin" {
            let low = SIMD3(scene.bounds.min), high = SIMD3(scene.bounds.max)
            let floor = VisionFloorGrid.referenceFloor(low: low, high: high, ground: groundHeight(scene))
            let half = SIMD3<Float>(max(4, high.x-low.x+2)/2, max(4, high.y-low.y+2)/2, 0.3)
            referenceFloorBounds = (floor.position-half, floor.position+half)
            floor.components.set(VisionSceneSelection(nodeID: "reference-floor", name: "参考地面", role: "ground"))
            floor.generateCollisionShapes(recursive: false)
            if var collision = floor.components[CollisionComponent.self] { collision.filter = CollisionFilter(group: mapGroup, mask: .all); floor.components.set(collision) }
            floor.components.set(InputTargetComponent()); content.addChild(floor)
        }
    }
    private func floor(at point: SIMD3<Float>, searchHeight: Float = 0.3) -> SIMD3<Float>? {
        guard let scene = manifest, let reality = root.scene else { return nil }
        let hits = reality.raycast(from: content.convert(position: point + SIMD3(0, 0, searchHeight), to: nil),
                                   to: content.convert(position: point - SIMD3(0, 0, 1.2), to: nil),
                                   query: .all, mask: mapGroup, relativeTo: nil)
        for hit in hits.sorted(by: { $0.distance < $1.distance }) {
            let local = content.convert(position: hit.position, from: nil)
            let normal = simd_normalize(content.convert(direction: hit.normal, from: nil))
            let bounds = hit.entity.components[VisionSceneSelection.self]?.role == "ground" ? referenceFloorBounds : nil
            if VisionSceneNavigation.standable(point: local, normal: normal, low: bounds?.low ?? SIMD3(scene.bounds.min), high: bounds?.high ?? SIMD3(scene.bounds.max)) { return local }
        }
        return nil
    }
    private func hasClearance(at point: SIMD3<Float>) -> Bool {
        guard let reality = root.scene else { return false }
        let height = max(1.2, min(2.1, (device()?.translation.y ?? 1.6) - physicalFloorHeight))
        // Shape resources are sized in world metres. Transform both the sweep
        // and its radius explicitly, so a miniature and a 1:1 scene agree.
        let scale = abs(content.scale(relativeTo: nil).x)
        let hits = reality.convexCast(convexShape: .generateSphere(radius: 0.24 * scale),
            fromPosition: content.convert(position: point + SIMD3(0, 0, 0.3), to: nil), fromOrientation: simd_quatf(),
            toPosition: content.convert(position: point + SIMD3(0, 0, height-0.2), to: nil), toOrientation: simd_quatf(),
            query: .all, mask: mapGroup.union(robotGroup), relativeTo: nil)
        return hits.isEmpty
    }
    func enterProject() {
        if let transform = groundTracking.confirmedPlacement {
            applyGroundPlacement(transform)
            navigationMessage = "已回到地图原点 · 点选地面可继续游走"
        } else { alignProjectToFloor() }
    }
    private func enterNearRobot() {
        guard let scene = manifest, let head = device() else { navigationMessage = "等待头显空间定位…"; return }
        let low = SIMD3(scene.bounds.min), high = SIMD3(scene.bounds.max)
        let robot = scene.robotRoot.flatMap { entities[$0]?.position(relativeTo: content) }
            ?? SIMD3((low.x+high.x)/2, (low.y+high.y)/2, low.z)
        let candidates = (entryPoint.map { [$0] } ?? []) + VisionSceneNavigation.entryCandidates(near: robot)
            + [SIMD3((low.x+high.x)/2, (low.y+high.y)/2, low.z)]
        if let ground = candidates.compactMap({ floor(at: $0, searchHeight: 0.8) }).first(where: { hasClearance(at: $0) }) {
            entryPoint = ground
            placeObserver(at: ground, heading: VisionSceneNavigation.horizontal(robot-ground), head: head)
            root.components.set(OpacityComponent(opacity: 1)); navigationMessage = "点选地面选择落点，捏合「前往此处」；转身查看周围"
        } else {
            overview(); navigationMessage = "机器人附近暂未找到空旷位置，可在沙盘中点选地面落点"
        }
    }
    private func placeObserver(at ground: SIMD3<Float>, heading: SIMD3<Float>?, head: simd_float4x4) {
        let rotation = heading.map { VisionSceneNavigation.orientation(projectForward: $0, head: head) } ?? stage.orientation
        content.position = -ground
        stage.transform = Transform(scale: SIMD3(repeating: 1), rotation: rotation, translation: VisionSceneNavigation.groundAnchor(head: head, floorHeight: physicalFloorHeight))
        lifeSize = true; positioned = true; configureManipulation(); refreshDetail(at: ground)
    }
    func proposeDestination(_ point: SIMD3<Float>) {
        guard immersiveProject, !travelling else { return }
        playing = false; clearSelection(); clearDestination()
        guard let ground = floor(at: point), abs(ground.z - point.z) < 0.35 else {
            navigationMessage = "请选择朝上的平坦地面"; return
        }
        guard hasClearance(at: ground) else { navigationMessage = "此处被模型占据，请选择空旷位置"; return }
        destination = ground; navigationMessage = "落点已选好，确认后前往"
        let radius: Float = 0.26 / max(stage.scale.x, 0.15)
        var previous = ground + SIMD3(radius, 0, 0.025)
        for i in 1...32 {
            let angle = Float(i) * .pi / 16
            let next = ground + SIMD3(cos(angle)*radius, sin(angle)*radius, 0.025)
            landing.addChild(VisionModelRenderer.line(from: previous, to: next, color: .systemMint, width: 0.012 / max(stage.scale.x, 0.15)))
            previous = next
        }
    }
    func clearDestination() { destination = nil; landing.children.forEach { $0.removeFromParent() } }
    func visit(_ marker: VisionSceneMarker) {
        guard !travelling else { return }
        playing = false
        let target = SIMD3<Float>(marker.position)
        // A parking point is often inside the robot base. Visit clear ground
        // beside it, so users can inspect the saved teaching position.
        let candidates = VisionSceneNavigation.entryCandidates(near: target) + [target]
        if let ground = candidates.compactMap({ floor(at: $0, searchHeight: 0.8) }).first(where: { hasClearance(at: $0) }) {
            proposeDestination(ground)
        } else { clearDestination(); navigationMessage = "该示教点附近暂未找到可进入的地面" }
    }
    func travel() {
        guard let ground = destination, !travelling, device() != nil else { return }
        // Validate again because a robot playback may have occupied the landing.
        guard hasClearance(at: ground) else { clearDestination(); navigationMessage = "落点已被占据，请重新选择"; return }
        let oldLifeSize = lifeSize, token = generation
        travelling = true; playing = false
        setParkingArrival(nil)
        travelTask = Task {
            do {
                for step in 1...4 { root.components.set(OpacityComponent(opacity: 1-Float(step)/4)); try await Task.sleep(for: .milliseconds(20)) }
                guard token == generation, let head = device() else { throw CancellationError() }
                let heading: SIMD3<Float>? = oldLifeSize ? nil : VisionSceneNavigation.horizontal(
                    (manifest?.robotRoot.flatMap { entities[$0]?.position(relativeTo: content) } ?? ground + SIMD3(0, 1, 0)) - ground)
                placeObserver(at: ground, heading: heading, head: head); clearDestination()
                for step in 1...6 { try await Task.sleep(for: .milliseconds(20)); root.components.set(OpacityComponent(opacity: Float(step)/6)) }
                navigationMessage = "已到达 · 点选下一处地面可继续游走"
            } catch { /* Cancelled by leaving or replacing the project. */ }
            if token == generation { travelling = false; root.components.set(OpacityComponent(opacity: 1)) }
        }
    }
    func turn(_ radians: Float) {
        guard lifeSize, !travelling, let head = device() else { return }
        clearDestination()
        let pivot = VisionSceneNavigation.groundAnchor(head: head, floorHeight: physicalFloorHeight), rotation = simd_quatf(angle: radians, axis: SIMD3(0, 1, 0))
        stage.position = pivot + rotation.act(stage.position-pivot); stage.orientation = rotation * stage.orientation
    }
    func returnToRobot() { guard !placingProject else { return }; entryPoint = nil; enterNearRobot(); clearDestination() }
    func setMeasurement(_ enabled: Bool) { measuring = enabled; clearSelection(); clearDestination() }
    private func configureManipulation() {
        // Geometry HitTargets redirect manipulation here. An enclosing box
        // would intercept surface selections and give incorrect measurements.
        guard manifest != nil else { return }
        if #available(visionOS 26.0, *) {
            if immersiveProject && lifeSize {
                stage.components.remove(ManipulationComponent.self)
                func removeTargets(_ entity: Entity) {
                    entity.components.remove(ManipulationComponent.HitTarget.self)
                    entity.children.forEach(removeTargets)
                }
                removeTargets(content)
                return
            }
            var manipulation = ManipulationComponent(); manipulation.releaseBehavior = .stay; manipulation.dynamics.inertia = .zero
            stage.components.set(manipulation)
            func addTargets(_ entity: Entity) {
                if entity.components.has(VisionSceneSelection.self) { entity.components.set(ManipulationComponent.HitTarget(redirectedEntity: stage)) }
                entity.children.forEach(addTargets)
            }
            addTargets(content)
        }
    }
    func select(_ item: VisionSceneSelection, point: SIMD3<Float>) {
        guard !immersiveProject || obstacleFade.amount < 0.8 else { return }
        if immersiveProject && !measuring {
            if item.role == "map" || item.role == "ground" { proposeDestination(point); return }
            clearDestination(); selection = item.name
            if let taskID = item.taskID, let index = manifest?.clips.firstIndex(where: { $0.id == taskID }) { chooseClip(index) }
            return
        }
        playing = false
        if let taskID = item.taskID, let index = manifest?.clips.firstIndex(where: { $0.id == taskID }) { chooseClip(index) }
        selection = item.name; focusPoint = point
        if let firstPoint, measurement == nil {
            measurement = simd_distance(firstPoint, point)
            annotation.addChild(VisionModelRenderer.line(from: firstPoint, to: point, color: .systemYellow, width: 0.004 / max(stage.scale.x, 0.01)))
        } else { annotation.children.forEach { $0.removeFromParent() }; firstPoint = point; measurement = nil }
        let marker = ModelEntity(mesh: .generateSphere(radius: 0.008 / max(stage.scale.x, 0.01)), materials: [UnlitMaterial(color: .systemYellow)])
        marker.position = point; annotation.addChild(marker)
    }
    func clearSelection() { firstPoint = nil; focusPoint = nil; measurement = nil; selection = ""; annotation.children.forEach { $0.removeFromParent() } }
    func chooseClip(_ index: Int) {
        guard manifest?.clips.indices.contains(index) == true else { return }
        clearSelection()
        clipIndex = index; playing = false; time = 0; progress = 0; applyPlayback()
    }
    func togglePlayback() {
        guard hasClips else { return }
        if !playing { clearSelection() }
        if clipIndex == nil { chooseClip(0) }
        if let clip, time >= clip.totalDurationMs { time = 0 }
        playing.toggle(); applyPlayback()
    }
    func scrub(_ value: Double) {
        guard let clip else { return }
        clearSelection()
        playing = false; progress = min(1, max(0, value)); time = progress * clip.totalDurationMs; applyPlayback()
    }
    private func applyJoint(_ joint: VisionSceneJoint, value: Float, to entity: Entity) {
        entity.transform = Transform(matrix: joint.matrix(value: value))
    }
    private func applyPlayback() {
        guard let scene = manifest, let clip else { return }
        let (pose, values) = clip.sample(milliseconds: time)
        if let id = scene.robotRoot { entities[id]?.transform = Transform(matrix: pose.matrix) }
        for node in scene.nodes {
            if let joint = node.joint, let entity = entities[node.id] { applyJoint(joint, value: values[joint.name] ?? joint.value, to: entity) }
        }
    }
    private func update(delta: Double) {
        guard immersed else { return }
        groundTracking.update(delta: delta)
        updateObstacleFade(delta: delta)
        updateParkingArrival(delta: delta)
        if let head = device() {
            let direction = simd_normalize((head * SIMD4(VisionSurfaceRenderer.mapViewLight, 0)).xyz)
            if mapLightDirection.map({ simd_dot($0, direction) < 0.99999 }) ?? true {
                mapLightDirection = direction
                for node in manifest?.nodes ?? [] where node.role == "map" {
                    if let mesh = meshes[node.id] { VisionSurfaceRenderer.updateMapLight(mesh, direction: direction) }
                }
            }
        }
        if !positioned && !immersiveProject && device() != nil { overview() }
        if playing, let clip {
            time = min(clip.totalDurationMs, time + min(delta, 0.1) * 1000); applyPlayback()
            if time >= clip.totalDurationMs { playing = false }
            if CACurrentMediaTime() - lastUI > 0.1 || !playing { progress = time / clip.totalDurationMs; lastUI = CACurrentMediaTime() }
        }
        if lifeSize, CACurrentMediaTime() - lastDetail > 1, let device = device() {
            lastDetail = CACurrentMediaTime(); refreshDetail(at: content.convert(position: device.translation, from: nil))
        }
    }
    private func updateParkingArrival(delta: Double) {
        let marker = VisionParkingArrival.nearest(in: parkingMarkers, head: device()?.translation,
            worldFromProject: content.transformMatrix(relativeTo: nil),
            enabled: immersiveProject && lifeSize && !placingProject && !travelling && !busy)
        setParkingArrival(marker)
        if marker != nil {
            parkingArrivalPhase += min(max(delta, 0), 0.1)
            let opacity = Float(0.8 + 0.2 * sin(parkingArrivalPhase * 2 * .pi / 1.4))
            parkingArrivalHalo?.components.set(OpacityComponent(opacity: opacity))
        }
    }
    private func setParkingArrival(_ marker: VisionSceneMarker?) {
        guard arrivedParkingPoint?.id != marker?.id else { return }
        if let previous = arrivedParkingPoint {
            parkingEntities[previous.id]?.model?.materials = [VisionSceneMarkers.material(for: previous)]
        }
        arrivedParkingPoint = marker; parkingArrivalPhase = 0
        parkingArrivalHalo?.isEnabled = marker != nil
        if let marker {
            parkingEntities[marker.id]?.model?.materials = [VisionSceneMarkers.material(for: marker, arrived: true)]
            parkingArrivalHalo?.position = SIMD3(marker.position) + SIMD3(0, 0, 0.012)
        }
    }
    private func updateObstacleFade(delta: Double) {
        guard immersiveProject, !placingProject else { return }
        let sample: VisionObstacleSample
        #if targetEnvironment(simulator)
        sample = simulatedObstacleDistance < 0 ? .unavailable : simulatedObstacleDistance > 2.5 ? .clear : .obstacle(simulatedObstacleDistance)
        #else
        sample = groundTracking.obstacleSample
        #endif
        obstacleFade.update(sample, delta: delta, passthroughVisible: passthroughVisible)
        let needsPassthrough = !lifeSize || obstacleFade.needsPassthrough
        if proximityPassthrough != needsPassthrough { proximityPassthrough = needsPassthrough }
        // The miniature is the existing fallback when room sensing is denied.
        // Keep it usable over real surroundings, without its enclosing sky.
        let opacity: Float = !lifeSize && sample == .unavailable ? 1 : 1 - obstacleFade.amount
        // Fully hidden geometry must not intercept input or manipulate an
        // invisible sandbox. Re-enabling preserves all transforms and state.
        stage.isEnabled = opacity > 0
        environment.isEnabled = lifeSize && opacity > 0
        if abs(opacity - obstacleOpacity) > 0.0001 {
            // Fade every virtual surface, including the sky, reference floor,
            // paths and models. The wrist control and SwiftUI windows remain.
            stage.components.set(OpacityComponent(opacity: opacity))
            environment.components.set(OpacityComponent(opacity: opacity))
            obstacleOpacity = opacity
        }
        let message: String
        switch sample {
        case .unavailable:
            #if targetEnvironment(simulator)
            message = "模拟环境感知中断 · 已保留真实环境"
            #else
            message = groundTracking.obstacleStatus.isEmpty ? "环境感知暂不可用，已保留真实环境" : groundTracking.obstacleStatus
            #endif
        case .obstacle(let distance) where distance < 2:
            message = String(format: "前方障碍物约 %.1f m · %@", distance, distance <= 1 ? "优先显示真实环境" : "真实环境正在渐显")
        default: message = obstacleFade.amount > 0.02 ? "正在平滑恢复沉浸画面" : ""
        }
        if proximityMessage != message { proximityMessage = message }
    }
    private func refreshDetail(at point: SIMD3<Float>?) {
        guard let scene = manifest else { return }
        let assets = Dictionary(uniqueKeysWithValues: scene.assets.map { ($0.id, $0) })
        let mapNodes = scene.nodes.filter {
            $0.role == "map" && $0.asset != nil && (!immersiveProject || assets[$0.asset!]?.manifest.indices == 0)
        }
        let nearest = point.map { p in Set(mapNodes.sorted { a, b in
            func distance(_ node: VisionSceneNode) -> Float {
                guard let bounds = assets[node.asset!]?.manifest.bounds else { return .infinity }
                return simd_length(simd_max(simd_max(bounds.min.simd - p, p - bounds.max.simd), .zero))
            }
            return distance(a) < distance(b)
        }.prefix(4).map(\.id)) } ?? []
        guard nearest != detailRequest || (detailTask == nil && nearest != mapDetails) else { return }
        detailTask?.cancel(); let changes = nearest.symmetricDifference(mapDetails), token = generation
        detailRequest = nearest; detailRevision = UUID(); let revision = detailRevision
        detailTask = Task {
            defer { if revision == detailRevision { detailTask = nil } }
            for node in mapNodes where changes.contains(node.id) {
                do {
                    let mesh = try await makeMesh(assets[node.asset!]!, node: node, detailed: nearest.contains(node.id))
                    guard !Task.isCancelled, token == generation else { return }
                    meshes[node.id]?.removeFromParent(); entities[node.id]?.addChild(mesh); meshes[node.id] = mesh
                    if nearest.contains(node.id) { mapDetails.insert(node.id) } else { mapDetails.remove(node.id) }
                } catch { if !Task.isCancelled { status = "局部细节暂不可用，已保留全景" } }
            }
        }
    }
}
