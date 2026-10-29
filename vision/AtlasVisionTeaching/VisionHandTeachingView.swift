import SwiftUI

struct VisionHandTeachingToggle: View {
    @ObservedObject var teaching: VisionHandTeachingController
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button {
            if teaching.active { teaching.stop(message: "已退出示教，机器人保持当前姿态") }
            else {
                teaching.start(scene: review, workbench: workbench)
                if review.hasCameras { openWindow(id: "project-cameras") }
            }
        } label: {
            Label(teaching.active ? "退出示教" : "开启示教", systemImage: "hand.pinch.fill")
                .visionPanelTarget(minWidth: 180, expands: false)
        }
        .disabled(teaching.recording || review.busy || workbench.openingScene || workbench.buildingScene)
        .accessibilityIdentifier("project-hand-teaching-toggle")
        .accessibilityValue(teaching.message)
        .accessibilityHint("用拇指和食指捏合控制双臂末端，松开停止")
    }
}

struct VisionHandTeachingView: View {
    @ObservedObject var teaching: VisionHandTeachingController

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Label("双臂手部示教", systemImage: "hand.pinch.fill").font(.title3.weight(.semibold))
            if teaching.active {
                HStack(spacing: 24) {
                    ForEach(VisionHandSide.allCases) { side in
                        let phase = teaching.phases[side] ?? .release
                        Label("\(side.title)：\(phase.title)", systemImage: phase == .controlling ? "hand.pinch.fill" : "pause.circle")
                            .foregroundStyle(phase == .unreachable || phase == .speedLimited ? Color.orange : .primary)
                            .accessibilityIdentifier("project-hand-\(side.rawValue)-status")
                    }
                }.font(.callout)
                HStack(spacing: VisionPanelMetrics.gap) {
                    Menu {
                        Picker("任务", selection: Binding(get: { teaching.taskID }, set: { teaching.taskID = $0; teaching.parkingID = "" })) {
                            Text("新建 Vision 双臂示教任务").tag("")
                            ForEach(teaching.tasks) { task in Text(task.name).tag(task.id) }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("示教任务").font(.callout).foregroundStyle(.secondary)
                            Text(teaching.tasks.first(where: { $0.id == teaching.taskID })?.name ?? "新建示教任务").lineLimit(1)
                        }.visionPanelTarget()
                    }.accessibilityIdentifier("project-hand-task")
                    Menu {
                        Picker("停车点", selection: $teaching.parkingID) {
                            Text("在当前基座新建停车点").tag("")
                            ForEach(teaching.tasks.first(where: { $0.id == teaching.taskID })?.parkingPoints ?? []) { point in Text(point.name).tag(point.id) }
                        }
                    } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("停车点").font(.callout).foregroundStyle(.secondary)
                            Text(teaching.tasks.first(where: { $0.id == teaching.taskID })?.parkingPoints.first(where: { $0.id == teaching.parkingID })?.name ?? "在当前基座新建").lineLimit(1)
                        }.visionPanelTarget()
                    }.accessibilityIdentifier("project-hand-parking")
                }.disabled(teaching.starting || teaching.recording)
                HStack(spacing: VisionPanelMetrics.gap) {
                    TextField("姿态名称（可选）", text: $teaching.poseName)
                        .textFieldStyle(.roundedBorder).controlSize(.extraLarge)
                        .accessibilityIdentifier("project-hand-pose-name")
                    Button { teaching.record() } label: {
                        Label(teaching.recording ? "正在记录…" : "记录当前姿态", systemImage: "record.circle")
                            .visionPanelTarget(minWidth: 260, expands: false)
                    }
                        .disabled(!teaching.enabled || teaching.recording)
                        .accessibilityIdentifier("project-hand-record")
                }.disabled(teaching.starting || teaching.recording)
            }
            if !teaching.message.isEmpty { Text(teaching.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.padding(24).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 20))
    }
}
