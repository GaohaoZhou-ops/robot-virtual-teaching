import SwiftUI

@MainActor
private final class VisionSceneCameraFeed: ObservableObject {
    @Published private(set) var images: [VisionSceneCameraSide: CGImage] = [:]
    @Published private(set) var loading = false
    @Published private(set) var error = ""
    private var generation = UUID()

    func run(_ review: VisionSceneController) async {
        generation = UUID(); let token = generation
        images = [:]; error = ""; loading = true
        defer { if generation == token { loading = false } }
        guard let manifest = review.manifest else { return }
        let renderer = VisionSceneCameraRenderer()
        do {
            try await renderer.prepare(manifest)
            try Task.checkCancellation()
            guard generation == token else { return }
            var previous: VisionSceneCameraSnapshot?
            while !Task.isCancelled, review.manifest?.id == manifest.id, generation == token {
                if let snapshot = review.cameraSnapshot(), snapshot != previous {
                    let frames = try await renderer.frames(snapshot)
                    try Task.checkCancellation()
                    guard generation == token else { return }
                    images = frames; previous = snapshot; loading = false
                }
                // Serial rendering avoids a backlog; unchanged poses render
                // once. Closing this window cancels preparation and the loop.
                try await Task.sleep(for: .milliseconds(100))
            }
        } catch is CancellationError { }
        catch { if generation == token { self.error = error.localizedDescription } }
    }
}

struct VisionSceneCameraView: View {
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.dismissWindow) private var dismissWindow
    @StateObject private var feed = VisionSceneCameraFeed()
    @State private var retry = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 16) {
                Label("Zivid 双相机", systemImage: "camera.on.rectangle").font(.title2.weight(.semibold))
                Text("虚拟取景 · M70").foregroundStyle(.secondary)
                Spacer()
                Button { dismissWindow(id: "project-cameras") } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("关闭双相机画面").accessibilityIdentifier("project-cameras-close")
            }
            HStack(alignment: .top, spacing: 20) {
                ForEach(VisionSceneCameraSide.allCases) { side in camera(side) }
            }
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Label("随机器人姿态更新", systemImage: "arrow.triangle.2.circlepath")
                    Text("画面为空时，请对准 0.3–1.3 m 内的模型").font(.caption)
                }
                Spacer()
                Text("视野 56.6° × 35.6° · 距离 0.3–1.3 m").monospacedDigit()
            }.font(.callout).foregroundStyle(.secondary)
            if !feed.error.isEmpty {
                HStack {
                    Text(feed.error).foregroundStyle(.orange)
                    Spacer()
                    Button("重试") { retry += 1 }.accessibilityIdentifier("project-cameras-retry")
                }
            }
        }
        .padding(24).frame(width: 1120)
        .task(id: "\(review.manifest?.id ?? "")-\(retry)") { await feed.run(review) }
        .onAppear {
            review.cameraWindowVisible = true
            if !review.immersed && !workbench.replacingScene { dismissWindow(id: "project-cameras") }
        }
        .onDisappear { review.cameraWindowVisible = false }
        .onChange(of: review.immersed) { _, immersed in
            if !immersed && !workbench.replacingScene { dismissWindow(id: "project-cameras") }
        }
        .onChange(of: workbench.replacingScene) { _, replacing in
            if !replacing && !review.immersed { dismissWindow(id: "project-cameras") }
        }
    }

    private func camera(_ side: VisionSceneCameraSide) -> some View {
        let available = review.manifest?.cameraNodes[side] != nil
        let tint: Color = side == .left ? .cyan : .mint
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Circle().fill(available ? tint : .secondary).frame(width: 8, height: 8)
                Text(side.title).font(.headline)
                Spacer()
                Text(side.rawValue.uppercased()).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
            ZStack {
                Color.black.opacity(0.8)
                if let image = feed.images[side], !review.busy {
                    Image(decorative: image, scale: 1).resizable().scaledToFit()
                    Image(systemName: "plus").font(.system(size: 18, weight: .ultraLight))
                        .foregroundStyle(.white.opacity(0.65)).accessibilityHidden(true)
                } else if !available {
                    Label("未找到\(side.title)光学坐标系", systemImage: "camera.fill").foregroundStyle(.secondary)
                } else if feed.loading || review.busy { ProgressView("正在准备取景…") }
                else { Text("取景暂不可用，请重试").foregroundStyle(.secondary) }
            }
            .aspectRatio(ZividFieldOfView.nativeAspect, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(tint.opacity(0.25)))
            .accessibilityElement(children: .ignore).accessibilityLabel("\(side.title)虚拟取景")
            .accessibilityValue(feed.images[side] != nil ? "画面已就绪" : available ? "正在准备" : "相机不可用")
            .accessibilityIdentifier("project-camera-\(side.rawValue)")
        }.frame(maxWidth: .infinity)
    }
}
