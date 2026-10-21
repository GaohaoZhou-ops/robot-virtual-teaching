import SwiftUI
import RealityKit

struct VisionImmersiveView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @State private var spaceID = UUID()
    var body: some View {
        RealityView { content, attachments in
            content.add(spatial.root)
            spatial.panelRoot.children.forEach { $0.removeFromParent() }
            if let panel = attachments.entity(for: "controls") { spatial.panelRoot.addChild(panel) }
        } attachments: {
            Attachment(id: "controls") {
                if session.current != nil {
                    VisionTeachingControls(compact: true).padding(28).frame(width: 680).glassBackgroundEffect()
                        .environmentObject(session).environmentObject(spatial)
                }
            }
        }
        // Resolve placement targets before recognizing the gesture. An all-entity
        // gesture also competes with the attachment's native button/toggle input,
        // even if its onEnded handler later ignores the attachment by name.
        .simultaneousGesture(SpatialTapGesture().targetedToEntity(spatial.planesRoot).onEnded { value in
            guard value.entity.name == "atlas-surface" else { return }
            let point = value.convert(value.location3D, from: .local, to: .scene)
            spatial.place(at: point)
        })
        .task { await spatial.spaceAppeared(spaceID) }
        .onDisappear {
            spatial.spaceDisappeared(spaceID)
            session.backgroundSave()
        }
    }
}
