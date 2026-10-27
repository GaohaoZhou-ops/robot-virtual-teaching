import RealityKit
import SwiftUI

/// A separate entity hierarchy keeps preview transforms out of spatial calibration.
@MainActor
private final class VisionPreviewScene: ObservableObject {
    @Published private(set) var source: ModelEntity?
    @Published private(set) var error = ""
    let root = Entity()
    private var sourceID: Entity.ID?
    private var diameter: Float = 1

    func load(_ model: ModelGeometry) async {
        source = nil; error = ""
        let build = Task.detached(priority: .userInitiated) { try VisionMeshData.preview(model: model) }
        do {
            let data = try await withTaskCancellationHandler(operation: { try await build.value }, onCancel: { build.cancel() })
            try Task.checkCancellation()
            let entity = try await VisionModelRenderer.makeEntity(data)
            try Task.checkCancellation()
            source = entity
        } catch {
            if !Task.isCancelled { self.error = "模型预览加载失败：\(error.localizedDescription)" }
        }
    }

    func update(source: ModelEntity, bounds: BoundingBox, yaw: Float, pitch: Float, zoom: Float) {
        if sourceID != source.id {
            root.children.removeAll()
            let copy = source.clone(recursive: true)
            let modelBounds = copy.visualBounds(relativeTo: nil)
            copy.position = -modelBounds.center
            diameter = max(simd_length(modelBounds.extents), 0.001)
            root.addChild(copy)
            sourceID = source.id
        }
        guard let framing = VisionPreviewFraming(diameter: diameter, availableSize: bounds.extents, zoom: zoom) else {
            root.isEnabled = false; return
        }
        root.isEnabled = true
        root.scale = SIMD3(repeating: framing.scale)
        // Keep the entire rotating sphere in front of the window's back plane.
        root.position = SIMD3(0, 0, framing.centerZ)
        // Source files are Z-up; the window's vertical axis is Y.
        root.orientation = simd_quatf(angle: pitch * .pi / 180, axis: SIMD3(1, 0, 0))
            * simd_quatf(angle: yaw * .pi / 180, axis: SIMD3(0, 1, 0))
            * simd_quatf(angle: -.pi / 2, axis: SIMD3(1, 0, 0))
    }
}

struct VisionModelPreview: View {
    private static let initialPose = VisionPreviewPose(zoom: 2)
    let model: ModelGeometry
    @StateObject private var scene = VisionPreviewScene()
    @State private var retry = 0
    @State private var pose = Self.initialPose
    @GestureState private var gesture = PreviewGesture()

    private struct PreviewGesture {
        var drag: SIMD2<Float> = .zero
        var magnification: Float = 1
    }

    private var displayedPose: VisionPreviewPose {
        pose.applying(drag: gesture.drag, magnification: gesture.magnification)
    }

    var body: some View {
        VStack(spacing: 24) {
            ZStack {
                if let source = scene.source {
                    GeometryReader3D { geometry in
                        RealityView { content in
                            content.add(scene.root)
                            scene.update(source: source, bounds: content.convert(geometry.frame(in: .local), from: .local, to: .scene),
                                         yaw: displayedPose.yaw, pitch: displayedPose.pitch, zoom: displayedPose.zoom)
                        } update: { content in
                            scene.update(source: source, bounds: content.convert(geometry.frame(in: .local), from: .local, to: .scene),
                                         yaw: displayedPose.yaw, pitch: displayedPose.pitch, zoom: displayedPose.zoom)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .frame(depth: 560)
                    // Keep interaction on the window plane while the rendering
                    // has its own positive depth in front of that plane.
                    .frame(depth: 0, alignment: .back)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    Color.clear
                    .contentShape(Rectangle())
                    .gesture(manipulationGesture)
                    .simultaneousGesture(TapGesture(count: 2).onEnded {
                        pose = Self.initialPose
                    })
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("三维模型预览")
                    .accessibilityValue(displayedPose.accessibilityValue)
                    .accessibilityHint("注视模型，捏住拖动旋转；双手捏合缩放；连续捏合两次复位。")
                    .accessibilityAdjustableAction { direction in
                        switch direction {
                        case .increment: pose = pose.applying(magnification: 1.25)
                        case .decrement: pose = pose.applying(magnification: 0.8)
                        @unknown default: break
                        }
                    }
                    .accessibilityAction(named: "向左旋转") { pose = pose.applying(drag: [-80, 0]) }
                    .accessibilityAction(named: "向右旋转") { pose = pose.applying(drag: [80, 0]) }
                    .accessibilityAction(named: "向上旋转") { pose = pose.applying(drag: [0, -60]) }
                    .accessibilityAction(named: "向下旋转") { pose = pose.applying(drag: [0, 60]) }
                    .accessibilityAction(named: "重置视角") { pose = Self.initialPose }
                    .accessibilityIdentifier("model-preview")
                } else if scene.error.isEmpty {
                    ProgressView("正在准备模型预览…")
                } else {
                    VStack(spacing: 24) {
                        Text(scene.error).foregroundStyle(.secondary)
                        Button("重试预览") { retry += 1 }.accessibilityIdentifier("retry-local-preview")
                    }
                }
            }
            .frame(minHeight: 280, maxHeight: .infinity)
            .frame(maxWidth: .infinity)
            .clipped()
            if scene.source != nil {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 28) { gestureHints }
                    VStack(alignment: .leading, spacing: 12) { gestureHints }
                }
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.vertical, 8)
                .accessibilityIdentifier("preview-gesture-hints")
            }
        }.task(id: retry) { await scene.load(model) }
    }

    private var manipulationGesture: some Gesture {
        DragGesture(minimumDistance: 3)
            .simultaneously(with: MagnifyGesture())
            .updating($gesture) { value, state, _ in
                let translation = value.first?.translation ?? .zero
                state = PreviewGesture(drag: [Float(translation.width), Float(translation.height)],
                                       magnification: Float(value.second?.magnification ?? 1))
            }
            .onEnded { value in
                let translation = value.first?.translation ?? .zero
                pose = pose.applying(drag: [Float(translation.width), Float(translation.height)],
                                     magnification: Float(value.second?.magnification ?? 1))
            }
    }

    @ViewBuilder private var gestureHints: some View {
        Label("捏住拖动 · 旋转", systemImage: "hand.draw")
        Label("双手捏合 · 缩放", systemImage: "arrow.up.left.and.arrow.down.right")
        Label("连续捏合两次 · 复位", systemImage: "arrow.counterclockwise")
    }
}
