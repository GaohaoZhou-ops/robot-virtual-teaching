import SwiftUI

struct VisionModelFileInfo: View {
    let manifest: ModelManifest

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(manifest.name).font(.title3.bold()).lineLimit(2)
            HStack(spacing: 24) {
                Label(ByteCountFormatter.string(fromByteCount: Int64(manifest.byteLength), countStyle: .file), systemImage: "doc")
                Text("\(manifest.vertices.formatted()) 个顶点")
                if manifest.indices > 0 { Text("\((manifest.indices / 3).formatted()) 个三角面") }
                else { Text("点云") }
            }.font(.callout).foregroundStyle(.secondary)
            if let bounds = manifest.bounds {
                let size = bounds.max.simd - bounds.min.simd
                Text(String(format: "尺寸 %.2f × %.2f × %.2f m", size.x, size.y, size.z))
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("model-file-info")
    }
}

struct VisionModelSyncView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("发现新模型").font(.largeTitle.bold())
            Text("Vision Pro 本地没有一致的模型文件，是否从电脑同步？")
                .font(.title3).foregroundStyle(.secondary)
            if let pending = session.pendingModel {
                ZStack {
                    Color(red: 0.04, green: 0.075, blue: 0.085)
                    if let data = pending.thumbnail, let image = UIImage(data: data) {
                        Image(uiImage: image).resizable().scaledToFit()
                            .accessibilityLabel("\(pending.session.manifest.name) 模型预览")
                            .accessibilityIdentifier("pending-model-thumbnail")
                    } else if !pending.previewError.isEmpty {
                        VStack(spacing: 20) {
                            Text(pending.previewError).font(.callout)
                            Button("重试预览") { Task { await session.loadPendingPreview() } }
                                .accessibilityIdentifier("retry-model-preview")
                        }.padding(24)
                    } else { ProgressView("正在加载模型预览…") }
                }
                .frame(height: 220).clipShape(RoundedRectangle(cornerRadius: 20))
                VisionModelFileInfo(manifest: pending.session.manifest)
            }
            if !session.error.isEmpty {
                Text(session.error).foregroundStyle(.red).accessibilityIdentifier("model-sync-error")
            }
            HStack(spacing: 24) {
                Button("暂不同步") { dismiss() }
                    .frame(minWidth: 180, minHeight: 64)
                    .accessibilityIdentifier("defer-model-sync")
                Button {
                    Task {
                        await session.syncPendingModel()
                        if session.pendingModel == nil { dismiss() }
                    }
                } label: {
                    HStack(spacing: 12) {
                        if session.busy { ProgressView().controlSize(.small) }
                        Text(session.busy ? "正在同步…" : "同步模型")
                    }.frame(minWidth: 200, minHeight: 64)
                }
                .buttonStyle(.borderedProminent).tint(.cyan)
                .accessibilityIdentifier("confirm-model-sync")
            }.disabled(session.busy)
        }
        .padding(32).frame(width: 760)
        .controlSize(.extraLarge)
        .interactiveDismissDisabled(session.busy)
        .task(id: session.pendingModel?.id) { await session.loadPendingPreview() }
    }
}
