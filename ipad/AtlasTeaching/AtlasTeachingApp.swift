import SwiftUI

@main
struct AtlasTeachingApp: App {
    @StateObject private var session = TeachingSession()
    var body: some Scene {
        WindowGroup { ScreenCollaborationHost().environmentObject(session).preferredColorScheme(.dark) }
    }
}
