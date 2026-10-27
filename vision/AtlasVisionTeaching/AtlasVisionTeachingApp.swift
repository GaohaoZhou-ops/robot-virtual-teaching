import SwiftUI

@main
struct AtlasVisionTeachingApp: App {
    @StateObject private var session = TeachingSession()
    @StateObject private var spatial = VisionTrackingController()
    @StateObject private var review = VisionSceneController()
    @StateObject private var workbench = VisionWorkbench()
    @State private var immersionStyle: ImmersionStyle = .mixed
    @State private var projectImmersion: ImmersionStyle = .mixed

    private var toolWindowRestoration: SceneRestorationBehavior {
        if #available(visionOS 26.0, *) { return .disabled }
        // Earlier systems close restored tools through their session guards.
        return .automatic
    }

    var body: some Scene {
        WindowGroup(id: "workspace", for: String.self) { _ in
            Group {
                #if targetEnvironment(simulator)
                if UserDefaults.standard.bool(forKey: "visionLegacyTeaching") {
                    VisionWorkspaceView().environmentObject(session).environmentObject(spatial).environmentObject(review)
                } else { VisionWorkbenchRoot().environmentObject(workbench).environmentObject(review).environmentObject(session).environmentObject(spatial) }
                #else
                VisionWorkbenchRoot().environmentObject(workbench).environmentObject(review).environmentObject(session).environmentObject(spatial)
                #endif
            }
        } defaultValue: { "workspace" }
        .defaultSize(width: 1440, height: 1000)

        WindowGroup(id: "project-tools", for: String.self) { value in
            VisionProjectToolsView(windowID: value.wrappedValue ?? "project-tools")
                .environmentObject(review).environmentObject(workbench)
        } defaultValue: { "project-tools" }
        .defaultSize(VisionProjectToolsView.defaultSize)
        .windowResizability(.contentSize)
        .defaultWorldScaling(.dynamic)
        .defaultWindowPlacement { _, _ in WindowPlacement(.utilityPanel) }
        .restorationBehavior(toolWindowRestoration)

        WindowGroup(id: "project-cameras", for: String.self) { _ in
            VisionSceneCameraView().environmentObject(review).environmentObject(workbench)
        } defaultValue: { "project-cameras" }
        .defaultSize(width: 1120, height: 530)
        .windowResizability(.contentSize)
        .defaultWindowPlacement { _, context in
            if let tools = context.windows.first(where: { $0.id == "project-tools" }) {
                return WindowPlacement(.above(tools))
            }
            return WindowPlacement(.utilityPanel)
        }
        .restorationBehavior(toolWindowRestoration)

        ImmersiveSpace(id: "project-space") {
            VisionProjectImmersiveView().environmentObject(review).environmentObject(workbench)
                .onChange(of: review.requiresPassthrough, initial: true) { _, passthrough in
                    projectImmersion = passthrough ? .mixed : .full
                }
                .onImmersionChange { _, value in review.immersionChanged(value.amount) }
        }.immersionStyle(selection: $projectImmersion, in: .mixed, .full)

        WindowGroup(id: "spatial-controls", for: String.self) { _ in
            VisionSpatialToolsWindow().environmentObject(session).environmentObject(spatial)
        } defaultValue: { "spatial-controls" }
        .windowResizability(.contentSize)
        .defaultWindowPlacement { _, _ in WindowPlacement(.utilityPanel) }
        .restorationBehavior(toolWindowRestoration)

        ImmersiveSpace(id: "teaching-space") {
            VisionImmersiveView().environmentObject(session).environmentObject(spatial)
        }
        .immersionStyle(selection: $immersionStyle, in: .mixed)

        WindowGroup(id: "scene-review-tools", for: String.self) { _ in
            VisionSceneToolsView().environmentObject(review)
        } defaultValue: { "scene-review-tools" }
        .defaultSize(width: 560, height: 240)
        .windowResizability(.contentSize)
        .defaultWindowPlacement { _, _ in WindowPlacement(.utilityPanel) }
        .restorationBehavior(toolWindowRestoration)

        ImmersiveSpace(id: "scene-review") {
            VisionSceneImmersiveView().environmentObject(review)
        }.immersionStyle(selection: $immersionStyle, in: .mixed)
    }
}
