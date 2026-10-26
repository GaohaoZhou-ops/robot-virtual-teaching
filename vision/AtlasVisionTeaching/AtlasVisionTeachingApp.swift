import SwiftUI

@main
struct AtlasVisionTeachingApp: App {
    @StateObject private var session = TeachingSession()
    @StateObject private var spatial = VisionTrackingController()
    @State private var immersionStyle: ImmersionStyle = .mixed

    var body: some Scene {
        WindowGroup(id: "workspace", for: String.self) { _ in
            VisionWorkspaceView().environmentObject(session).environmentObject(spatial)
        } defaultValue: { "workspace" }
        .defaultSize(width: 1180, height: 900)

        WindowGroup(id: "spatial-controls", for: String.self) { _ in
            VisionSpatialToolsWindow().environmentObject(session).environmentObject(spatial)
        } defaultValue: { "spatial-controls" }
        .windowResizability(.contentSize)
        .defaultWindowPlacement { _, _ in WindowPlacement(.utilityPanel) }

        ImmersiveSpace(id: "teaching-space") {
            VisionImmersiveView().environmentObject(session).environmentObject(spatial)
        }
        .immersionStyle(selection: $immersionStyle, in: .mixed)
    }
}
