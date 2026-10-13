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

    func update(source: ModelEntity, availableSize: SIMD3<Float>, yaw: Float, pitch: Float, zoom: Float) {
        if sourceID != source.id {
            root.children.removeAll()
            let copy = source.clone(recursive: true)
            let modelBounds = copy.visualBounds(relativeTo: nil)
            copy.position = -modelBounds.center
            diameter = max(simd_length(modelBounds.extents), 0.001)
            root.addChild(copy)
            sourceID = source.id
        }
        let scale = min(availableSize.x, availableSize.y) * 0.82 / diameter * zoom
        root.scale = SIMD3(repeating: scale)
        root.position = .zero
        // Source files are Z-up; the window's vertical axis is Y.
        root.orientation = simd_quatf(angle: pitch * .pi / 180, axis: SIMD3(1, 0, 0))
            * simd_quatf(angle: yaw * .pi / 180, axis: SIMD3(0, 1, 0))
            * simd_quatf(angle: -.pi / 2, axis: SIMD3(1, 0, 0))
    }
}

struct VisionModelPreview: View {
    let model: ModelGeometry
    @StateObject private var scene = VisionPreviewScene()
    @State private var retry = 0
    @State private var yaw: Float = -30
    @State private var pitch: Float = 20
    @State private var zoom: Float = 1

    private var ready: Bool { scene.source != nil && scene.error.isEmpty }

    var body: some View {
        VStack(spacing: 24) {
            ZStack {
                if let source = scene.source {
                    GeometryReader3D { geometry in
                        RealityView { content in
                            content.add(scene.root)
                            scene.update(source: source, availableSize: content.convert(geometry.size, from: .local, to: .scene),
                                         yaw: yaw, pitch: pitch, zoom: zoom)
                        } update: { content in
                            scene.update(source: source, availableSize: content.convert(geometry.size, from: .local, to: .scene),
                                         yaw: yaw, pitch: pitch, zoom: zoom)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("三维模型预览")
                    .accessibilityValue("水平 \(Int(yaw))°，俯仰 \(Int(pitch))°，缩放 \(Int((zoom * 100).rounded()))%")
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
            .frame(depth: 0)
            .clipped()
            HStack(spacing: 24) {
                previewButton("向左旋转", symbol: "arrow.turn.up.left", id: "preview-rotate-left") { yaw -= 30 }
                previewButton("向右旋转", symbol: "arrow.turn.up.right", id: "preview-rotate-right") { yaw += 30 }
                previewButton("向上旋转", symbol: "arrow.up", id: "preview-tilt-up") { pitch = min(80, pitch + 15) }
                    .disabled(pitch >= 80)
                previewButton("向下旋转", symbol: "arrow.down", id: "preview-tilt-down") { pitch = max(-80, pitch - 15) }
                    .disabled(pitch <= -80)
                previewButton("缩小模型", symbol: "minus.magnifyingglass", id: "preview-zoom-out") { zoom = max(0.5, zoom - 0.25) }
                    .disabled(zoom <= 0.5)
                previewButton("放大模型", symbol: "plus.magnifyingglass", id: "preview-zoom-in") { zoom = min(2, zoom + 0.25) }
                    .disabled(zoom >= 2)
                previewButton("重置视角", symbol: "arrow.counterclockwise", id: "preview-reset") { yaw = -30; pitch = 20; zoom = 1 }
            }.disabled(!ready)
        }.task(id: retry) { await scene.load(model) }
    }

    private func previewButton(_ label: String, symbol: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.title2).frame(width: 64, height: 64)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
                .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain).hoverEffect(.highlight)
        .accessibilityLabel(label).accessibilityIdentifier(id)
        .help(label)
    }
}
