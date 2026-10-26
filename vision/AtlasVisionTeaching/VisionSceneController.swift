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
    let root = Entity(), stage = Entity(), axes = Entity(), content = Entity(), annotation = Entity()
    private let landing = Entity(), environment = Entity()
    private let mapGroup = CollisionGroup(rawValue: 1 << 4)
    private let robotGroup = CollisionGroup(rawValue: 1 << 5)
    private var travelTask: Task<Void, Never>?
    private var entryPoint: SIMD3<Float>?
    private var entryAttempts = 0
    private var trackingWait = 0.0
    private var referenceFloorBounds: (low: SIMD3<Float>, high: SIMD3<Float>)?
    private var entities: [String: Entity] = [:]
    private var meshes: [String: ModelEntity] = [:]
    private var mapDetails = Set<String>()
    private var subscriptions: [EventSubscription] = []
    private var session: ARKitSession?
    private var world: WorldTrackingProvider?
    private var positioned = false
    private var generation = UUID()
    private var detailTask: Task<Void, Never>?
    private var detailRequest = Set<String>()
    private var detailRevision = UUID()
    private var time = 0.0, lastDetail = 0.0, lastUI = 0.0
    private var firstPoint: SIMD3<Float>?
    private var focusPoint: SIMD3<Float>?
    var clip: VisionSceneClip? { clipIndex.flatMap { manifest?.clips.indices.contains($0) == true ? manifest?.clips[$0] : nil } }
    var hasClips: Bool { manifest?.clips.isEmpty == false }

    init() {
        VisionSceneSelection.registerComponent()
        root.addChild(stage); stage.addChild(axes); axes.addChild(content)
        axes.transform = Transform(matrix: TeachingCoordinates.zUpToAR)
        content.addChild(annotation); content.addChild(landing); root.addChild(environment)
    }
    func prepare(_ scene: VisionSceneManifest, immersiveProject: Bool = false) async throws {
        stop(); generation = UUID(); let token = generation
        self.immersiveProject = immersiveProject; lifeSize = immersiveProject; measuring = false; entryPoint = nil
        referenceFloorBounds = nil
        root.components.set(OpacityComponent(opacity: 1)); environment.children.forEach { $0.removeFromParent() }
        busy = true; error = ""; defer { busy = false }
        try scene.validate(); manifest = scene; clipIndex = nil; time = 0; progress = 0
        entities.removeAll(); meshes.removeAll(); mapDetails.removeAll(); clearSelection()
        content.children.filter { $0 !== annotation && $0 !== landing }.forEach { $0.removeFromParent() }
        clearDestination()
        let assets = Dictionary(uniqueKeysWithValues: scene.assets.map { ($0.id, $0) })
        do {
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
            try await addPaths(scene.paths, width: width)
            let markerMesh = MeshResource.generateSphere(radius: max(0.025, simd_length(extent) / 600))
            for marker in scene.markers {
                let entity = ModelEntity(mesh: markerMesh, materials: [UnlitMaterial(color: marker.kind == "camera" ? .systemYellow : .systemMint)])
                entity.position = SIMD3(marker.position); entity.name = marker.name
                entity.components.set(VisionSceneSelection(nodeID: marker.id, name: marker.name, taskID: marker.taskId, role: "marker"))
                entity.generateCollisionShapes(recursive: false); entity.components.set(InputTargetComponent()); entity.components.set(HoverEffectComponent())
                if #available(visionOS 26.0, *) { entity.components.set(ManipulationComponent.HitTarget(redirectedEntity: stage)) }
                content.addChild(entity)
            }
            if immersiveProject { addEnvironment(scene) }
            configureManipulation(); status = immersiveProject ? "点选地面选择落点；在沙盘中可快速前往远处" : "双手捏住沙盘缩放和旋转；双击局部进入原大查看"
        } catch {
            content.children.filter { $0 !== annotation && $0 !== landing }.forEach { $0.removeFromParent() }
            manifest = nil; entities.removeAll(); meshes.removeAll(); throw error
        }
    }
    // Keep every route segment, but batch nearby segments instead of issuing one
    // draw call per line. Mesh chunks also keep cancellation and culling useful.
    private func addPaths(_ paths: [VisionScenePath], width: Float) async throws {
        var positions: [SIMD3<Float>] = [], indices: [UInt32] = []
        func flush() async throws {
            guard !positions.isEmpty else { return }
            try Task.checkCancellation()
            var descriptor = MeshDescriptor(name: "Scene routes")
            descriptor.positions = MeshBuffers.Positions(positions); descriptor.primitives = .triangles(indices)
            let mesh = try await MeshResource(from: [descriptor])
            content.addChild(ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: .systemCyan)]))
            positions.removeAll(keepingCapacity: true); indices.removeAll(keepingCapacity: true)
        }
        for path in paths {
            for pair in zip(path.points, path.points.dropFirst()) {
                let a = SIMD3(pair.0), b = SIMD3(pair.1), delta = b - a
                guard simd_length(delta) > 0.00001 else { continue }
                let direction = simd_normalize(delta)
                let u = simd_normalize(simd_cross(direction, abs(direction.z) < 0.9 ? SIMD3(0, 0, 1) : SIMD3(0, 1, 0))) * width / 2
                let v = simd_normalize(simd_cross(direction, u)) * width / 2, first = UInt32(positions.count)
                positions += [a-u-v, a+u-v, a+u+v, a-u+v, b-u-v, b+u-v, b+u+v, b-u+v]
                indices += [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7].map { first + $0 }
                if positions.count >= 32768 { try await flush() }
            }
            try await flush()
        }
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
        let data = try await Task.detached(priority: .userInitiated) {
            try VisionMeshData(model: model, mode: useMesh ? .mesh : .points, quality: .full, pointRadius: radius, primitiveBudget: budget)
        }.value
        try Task.checkCancellation()
        let entity = try await VisionModelRenderer.makeEntity(data)
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
        entryAttempts = 0; trackingWait = 0
        #if !targetEnvironment(simulator)
        let session = ARKitSession(), provider = WorldTrackingProvider(); self.session = session; world = provider
        do { try await session.run([provider]) } catch { self.error = "空间定位暂不可用，可先查看沙盘" }
        #endif
        if immersiveProject {
            root.components.set(OpacityComponent(opacity: 0))
            if device() != nil { enterProject() } else if !error.isEmpty { overview(); positioned = true }
        } else { overview() }
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
        session?.stop(); session = nil; world = nil
    }
    private func device() -> simd_float4x4? {
        #if targetEnvironment(simulator)
        var value = matrix_identity_float4x4; value.columns.3 = SIMD4(0, 1.6, 0, 1); return value
        #else
        guard let anchor = world?.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), anchor.isTracked else { return nil }
        return anchor.originFromAnchorTransform
        #endif
    }
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
        travelTask?.cancel(); travelling = false; root.components.set(OpacityComponent(opacity: 1)); clearDestination()
        let low = SIMD3(scene.bounds.min), high = SIMD3(scene.bounds.max), size = high - low
        placeStage(scale: min(0.7, max(0.0001, 1.4 / max(size.x, size.y, size.z, 0.1))), focus: SIMD3((low.x + high.x) / 2, (low.y + high.y) / 2, low.z), vertical: -0.45)
        lifeSize = false; environment.isEnabled = immersiveProject; configureManipulation(); refreshDetail(at: nil)
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
        let eyeHeight = max(0.8, device()?.translation.y ?? 1.6)
        let ground = robotOrigin?.z ?? scene.bounds.min[2]
        let vertical = min(-0.15, target.z - ground - eyeHeight)
        focusPoint = target; placeStage(scale: 1, focus: target, vertical: vertical); lifeSize = true
        refreshDetail(at: target)
    }
    private func addEnvironment(_ scene: VisionSceneManifest) {
        let sky = ModelEntity(mesh: .generateSphere(radius: 500), materials: [UnlitMaterial(color: UIColor(red: 0.035, green: 0.055, blue: 0.065, alpha: 1))])
        sky.scale = SIMD3(-1, 1, 1); environment.addChild(sky)
        let mapAssets = Set(scene.nodes.filter { $0.role == "map" }.compactMap(\.asset))
        let pointCloud = scene.assets.filter { mapAssets.contains($0.id) }.allSatisfy { $0.manifest.indices == 0 }
        // Sparse point clouds and isolated workpieces have no continuous floor.
        // Supply a clearly visible reference plane at the robot's ground level.
        if pointCloud || scene.coordinateFrame == "virtual_origin" {
            let low = SIMD3(scene.bounds.min), high = SIMD3(scene.bounds.max)
            let ground = scene.robotRoot.flatMap { entities[$0]?.position(relativeTo: content).z } ?? low.z
            let floor = ModelEntity(mesh: .generateBox(size: SIMD3(max(4, high.x-low.x+2), max(4, high.y-low.y+2), 0.02)),
                                    materials: [UnlitMaterial(color: UIColor(red: 0.07, green: 0.105, blue: 0.115, alpha: 1))])
            floor.position = SIMD3((low.x+high.x)/2, (low.y+high.y)/2, ground-0.012)
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
        let height = max(1.2, min(2.1, device()?.translation.y ?? 1.6))
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
            entryAttempts += 1
            if entryAttempts >= 12 || positioned {
                overview(); navigationMessage = "暂未找到合适的入口，请在沙盘中点选地面落点"
            }
        }
    }
    private func placeObserver(at ground: SIMD3<Float>, heading: SIMD3<Float>?, head: simd_float4x4) {
        let rotation = heading.map { VisionSceneNavigation.orientation(projectForward: $0, head: head) } ?? stage.orientation
        content.position = -ground
        stage.transform = Transform(scale: SIMD3(repeating: 1), rotation: rotation, translation: VisionSceneNavigation.groundAnchor(head: head))
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
        let pivot = VisionSceneNavigation.groundAnchor(head: head), rotation = simd_quatf(angle: radians, axis: SIMD3(0, 1, 0))
        stage.position = pivot + rotation.act(stage.position-pivot); stage.orientation = rotation * stage.orientation
    }
    func returnToRobot() { entryPoint = nil; enterProject(); clearDestination() }
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
        if !positioned {
            if device() != nil { if immersiveProject { enterProject() } else { overview() } }
            else if immersiveProject {
                trackingWait += delta
                if trackingWait > 5 {
                    overview(); positioned = true
                    navigationMessage = "空间定位尚未就绪，先以沙盘查看；定位恢复后可选择「进入」"
                }
            }
        }
        if playing, let clip {
            time = min(clip.totalDurationMs, time + min(delta, 0.1) * 1000); applyPlayback()
            if time >= clip.totalDurationMs { playing = false }
            if CACurrentMediaTime() - lastUI > 0.1 || !playing { progress = time / clip.totalDurationMs; lastUI = CACurrentMediaTime() }
        }
        if lifeSize, CACurrentMediaTime() - lastDetail > 1, let device = device() {
            lastDetail = CACurrentMediaTime(); refreshDetail(at: content.convert(position: device.translation, from: nil))
        }
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
