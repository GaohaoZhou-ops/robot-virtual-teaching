import SwiftUI
import RealityKit

struct VisionImmersiveView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.scenePhase) private var scenePhase
    @State private var spaceID = UUID()
    var body: some View {
        Group {
            if #available(visionOS 26.0, *) { scene }
            else { scene.simultaneousGesture(legacyCameraDrag) }
        }
    }
    private var scene: some View {
        RealityView { content in
            content.add(spatial.root)
        }
        // Keep placement, surface selection and saved-view selection separate
        // from the camera/workpiece manipulation recognizers.
        .simultaneousGesture(SpatialTapGesture().targetedToEntity(spatial.planesRoot).onEnded { value in
            guard value.entity.name == "atlas-surface" else { return }
            let point = value.convert(value.location3D, from: .local, to: .scene)
            spatial.place(at: point)
        })
        .simultaneousGesture(SpatialTapGesture().targetedToEntity(where: .has(VisionSurfaceTarget.self)).onEnded { value in
            spatial.focusCamera(at: value.convert(value.location3D, from: .local, to: spatial.objectRoot))
        })
        .simultaneousGesture(SpatialTapGesture().targetedToEntity(where: .has(VisionRecordedTarget.self)).onEnded { value in
            if let target = value.entity.components[VisionRecordedTarget.self] { spatial.selectRecordedTarget(target.sampleID) }
        })
        .task { await spatial.spaceAppeared(spaceID); spatial.bindSpatialGestures() }
        .onChange(of: spatial.targetCommit) { _, _ in session.saveSpatialDraft(spatial.cameraTarget?.draft) }
        .onChange(of: session.current?.result.samples.map(\.id)) { _, _ in spatial.refreshMarkers(session.current?.result.samples ?? []) }
        .onChange(of: scenePhase) { _, phase in if phase == .background { session.backgroundSave(); spatial.cancelTargetGesture() } }
        .onDisappear {
            spatial.spaceDisappeared(spaceID)
            session.backgroundSave()
            openWindow(id: "workspace", value: "workspace")
            dismissWindow(id: "spatial-controls")
        }
    }
    private var legacyCameraDrag: some Gesture {
        DragGesture().targetedToEntity(spatial.cameraRig).onChanged { value in
            if !spatial.isManipulating { spatial.beginTargetGesture(entity: spatial.cameraRig) }
            guard let start = spatial.gestureTarget else { return }
            let delta = value.convert(value.translation3D, from: .local, to: spatial.objectRoot)
            spatial.cameraRig.position = start.position + delta
            spatial.updateTargetGesture(entity: spatial.cameraRig)
        }.onEnded { _ in spatial.endTargetGesture(entity: spatial.cameraRig, cancelled: false) }
    }
}
