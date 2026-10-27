import SceneKit
import Metal

/// Both virtual cameras share one offscreen scene. Only the source map/model
/// geometry is included, matching the desktop Zivid view without tool overlays.
actor VisionSceneCameraRenderer {
    static let imageSize = CGSize(width: 648, height: 400)
    private var renderer: SCNRenderer?
    private let camera = SCNNode()
    private var mapNodes: [String: SCNNode] = [:]
    private var cameraNodes: [VisionSceneCameraSide: String] = [:]

    func prepare(_ manifest: VisionSceneManifest, store: VisionSceneStore = .shared) async throws {
        try Task.checkCancellation()
        guard let device = MTLCreateSystemDefaultDevice() else { throw TeachingError("相机取景渲染器暂不可用") }
        renderer = nil; mapNodes.removeAll(); cameraNodes = manifest.cameraNodes
        guard !cameraNodes.isEmpty else { throw TeachingError("当前机器人没有 Zivid 光学坐标系") }
        let scene = SCNScene()
        scene.background.contents = CGColor(red: 0.025, green: 0.045, blue: 0.065, alpha: 1)
        let assets = Dictionary(uniqueKeysWithValues: manifest.assets.map { ($0.id, $0) })
        var geometries: [String: SCNGeometry] = [:]
        for node in manifest.nodes where node.role == "map" {
            try Task.checkCancellation()
            guard let id = node.asset, let asset = assets[id] else { continue }
            let geometry: SCNGeometry
            if let cached = geometries[id] { geometry = cached }
            else {
                let model = try await store.model(asset)
                // Tiles already cap individual meshes at 60k faces. Preserve
                // their surfaces; triangle sampling creates false visibility.
                geometry = try model.makeGeometry(settings: ModelDisplaySettings(mode: .mesh, pointDensity: .full, meshQuality: .full))
                geometries[id] = geometry
            }
            let entity = SCNNode(geometry: geometry); entity.name = node.name
            scene.rootNode.addChildNode(entity); mapNodes[node.id] = entity
        }
        try Task.checkCancellation()
        guard !mapNodes.isEmpty else { throw TeachingError("当前工程没有可取景的地图或模型") }
        let lens = SCNCamera()
        lens.zNear = Double(ZividFieldOfView.near); lens.zFar = Double(ZividFieldOfView.far)
        lens.automaticallyAdjustsZRange = false; lens.wantsHDR = false
        // M70's horizontal and vertical FOV are independent of raster aspect.
        lens.projectionTransform = SCNMatrix4(ZividFieldOfView.projectionMatrix)
        camera.camera = lens; scene.rootNode.addChildNode(camera)
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene; renderer.pointOfView = camera
        self.renderer = renderer
    }

    func frames(_ snapshot: VisionSceneCameraSnapshot) throws -> [VisionSceneCameraSide: CGImage] {
        try Task.checkCancellation()
        guard let renderer else { throw TeachingError("相机取景尚未准备好") }
        for (id, node) in mapNodes {
            node.isHidden = snapshot.transforms[id] == nil
            if let transform = snapshot.transforms[id] { node.simdTransform = transform }
        }
        var images: [VisionSceneCameraSide: CGImage] = [:]
        for side in VisionSceneCameraSide.allCases {
            try Task.checkCancellation()
            guard let id = cameraNodes[side], let transform = snapshot.cameraTransform(id) else { continue }
            camera.simdTransform = transform
            let image = renderer.snapshot(atTime: 0, with: Self.imageSize, antialiasingMode: .multisampling2X)
            #if os(macOS)
            let frame = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
            #else
            let frame = image.cgImage
            #endif
            guard let frame else { throw TeachingError("\(side.title)画面生成失败，请重试") }
            images[side] = frame
        }
        guard !images.isEmpty else { throw TeachingError("未获取到相机位姿，请更新空间后重试") }
        return images
    }
}
