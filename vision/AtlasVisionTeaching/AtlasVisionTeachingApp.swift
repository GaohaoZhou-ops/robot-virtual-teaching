import SwiftUI

@main
struct AtlasVisionTeachingApp: App {
    @StateObject private var session = TeachingSession()
    @StateObject private var spatial = VisionTrackingController()
    @State private var immersionStyle: ImmersionStyle = .mixed

    var body: some Scene {
        WindowGroup(id: "workspace") {
            VisionWorkspaceView().environmentObject(session).environmentObject(spatial)
        }
        .defaultSize(width: 1180, height: 900)

        ImmersiveSpace(id: "teaching-space") {
            VisionImmersiveView().environmentObject(session).environmentObject(spatial)
        }
        .immersionStyle(selection: $immersionStyle, in: .mixed)
    }
}
