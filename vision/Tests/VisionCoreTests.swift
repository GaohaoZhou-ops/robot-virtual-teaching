import Foundation
import simd
import ImageIO

@main struct VisionCoreTests {
    static func near(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ label: String) {
        precondition(simd_distance(a, b) < 0.00001, label)
    }
    static func same(_ a: simd_float4x4, _ b: simd_float4x4) {
        precondition(zip(a.elements, b.elements).allSatisfy { abs($0 - $1) < 0.00001 })
    }
    static func main() async throws {
        let args = CommandLine.arguments, base = args[1], fixture = URL(fileURLWithPath: args[2])
        var placement = VisionPlacement(reference: SIMD3(0.4, 0.6, 0.2))
        precondition(placement.transform == nil && !placement.isCalibrated)
        placement.hit = SIMD3(1, 0.7, -2); placement.yaw = 37; placement.roll = 12; placement.pitch = -21
        let first = try placement.confirm(), initial = placement.transform!
        near((initial * SIMD4(placement.reference, 1)).xyz, placement.hit!, "the model reference lands exactly on the selected surface")
        precondition(VisionPoseMath.isRigid(initial))
        var device = simd_float4x4(simd_quatf(angle: 0.6, axis: simd_normalize(SIMD3(1, 2, 3))))
        device.columns.3 = SIMD4(0.5, 1.6, -0.1, 1)
        let sample = try VisionPoseMath.sample(device: device, worldFromModel: initial, segmentID: first.id)
        let p = sample.cameraPose
        precondition(p.frameName == VisionPoseMath.frameName)
        var modelFromOptical = simd_float4x4(simd_quatf(vector: SIMD4(p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w)))
        modelFromOptical.columns.3 = SIMD4(p.position.simd, 1)
        same(initial * modelFromOptical * TeachingCoordinates.opticalToARCamera, device)
        let standard = try VisionPoseMath.sample(device: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR, segmentID: first.id)
        let q = standard.cameraPose.quaternion
        near(simd_quatf(vector: SIMD4(q.x, q.y, q.z, q.w)).act(SIMD3(0, 0, 1)), SIMD3(0, 1, 0), "head forward maps to model +Y")
        let refinement = simd_float4x4(simd_quatf(angle: 0.01, axis: SIMD3(0, 1, 0))) * initial
        placement.refine(refinement); placement.unlock(); same(placement.transform!, refinement)
        precondition(!placement.isCalibrated, "unlock invalidates the sampling segment")
        let second = try placement.confirm()
        precondition(second.id != first.id, "recalibration creates a new segment")
        var gestured = VisionPlacement(reference: placement.reference)
        gestured.moveDraft(to: refinement)
        same(gestured.transform!, refinement)
        let gesturedCalibration = try gestured.confirm()
        same(simd_float4x4(elements: gesturedCalibration.worldFromModel), refinement)
        var camera = try VisionCameraTarget(transform: modelFromOptical)
        let focus = camera.position + camera.transform.columns.2.xyz * 0.7
        camera = try camera.aiming(at: focus)
        near(camera.transform.columns.2.xyz, simd_normalize(focus - camera.position), "selected surface is the optical +Z target")
        let movedCamera = try camera.moving(to: camera.position + SIMD3(0.2, 0.05, 0), keepFocus: true)
        near(movedCamera.transform.columns.2.xyz, simd_normalize(focus - movedCamera.position), "moving a locked camera keeps its aim")
        let closeCamera = try movedCamera.atDistance(0.4)
        precondition(abs(closeCamera.distance! - 0.4) < 0.00001)
        let authored = try closeCamera.sample(segmentID: second.id)
        precondition(authored.cameraPose.frameName == VisionCameraTarget.frameName)
        same(simd_float4x4(elements: authored.previewCameraTransform!), closeCamera.transform * TeachingCoordinates.opticalToARCamera)
        let cameraDraft = try JSONDecoder().decode(SpatialCameraDraft.self, from: JSONEncoder().encode(closeCamera.draft))
        same(try VisionCameraTarget(draft: cameraDraft).transform, closeCamera.transform)
        var freeCamera = closeCamera; freeCamera.focusLocked = false
        let freeDraft = try JSONDecoder().decode(SpatialCameraDraft.self, from: JSONEncoder().encode(freeCamera.draft))
        let restoredFreeCamera = try VisionCameraTarget(draft: freeDraft)
        precondition(!restoredFreeCamera.focusLocked, "free orientation must survive reopening")
        var history = VisionTargetHistory(); history.push(camera); history.push(movedCamera)
        same(history.pop()!.transform, movedCamera.transform); same(history.pop()!.transform, camera.transform)
        precondition(history.pop() == nil)
        // Vertical pointing must remain a right-handed rigid optical transform.
        let pole = try camera.aiming(at: camera.position + SIMD3(0, 0, 0.7))
        precondition(VisionPoseMath.isRigid(pole.transform))
        for distance: Float in [.nan, 0, 1.4] {
            do { _ = try camera.atDistance(distance); preconditionFailure("invalid shooting distance accepted") } catch is TeachingError {}
        }
        do { _ = try camera.moving(to: SIMD3(.infinity, 0, 0), keepFocus: false); preconditionFailure("invalid drag accepted") } catch is TeachingError {}
        for invalid in [simd_float4x4(diagonal: SIMD4(2, 1, 1, 1)), simd_float4x4(diagonal: SIMD4(-1, 1, 1, 1)), simd_float4x4(diagonal: SIMD4(Float.nan, 1, 1, 1))] {
            precondition(!VisionPoseMath.isRigid(invalid))
            do { _ = try VisionPoseMath.sample(device: invalid, worldFromModel: initial, segmentID: first.id); preconditionFailure("invalid pose accepted") }
            catch is TeachingError {}
        }
        let plane: [SIMD3<Float>] = [SIMD3(-1, 0, -1), SIMD3(1, 0, -1), SIMD3(-1, 0, 1)]
        near(VisionPoseMath.intersection(origin: SIMD3(-0.5, 1, -0.5), direction: SIMD3(0, -1, 0), vertices: plane, indices: [0, 1, 2])!, SIMD3(-0.5, 0, -0.5), "observed triangle hit")
        precondition(VisionPoseMath.intersection(origin: SIMD3(0.8, 1, 0.8), direction: SIMD3(0, -1, 0), vertices: plane, indices: [0, 1, 2]) == nil, "unobserved corner must not count as a surface")
        let manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: fixture.appendingPathExtension("json")))
        let bytes = try Data(contentsOf: fixture.appendingPathExtension("atls"))
        let model = try ModelGeometry(data: bytes, manifest: manifest)
        for quality in VisionQuality.allCases {
            let mesh = try VisionMeshData(model: model, mode: .mesh, quality: quality)
            precondition(mesh.primitiveCount == 12 && mesh.positions.count == 36 && mesh.triangles.count == 36)
            precondition(mesh.positions.allSatisfy { abs($0.x) <= 0.5 && abs($0.y) <= 0.5 && abs($0.z) <= 0.5 }, "rendering never rescales vertices")
            let points = try VisionMeshData(model: model, mode: .points, quality: quality)
            precondition(points.positions.count == model.vertices * 4 && points.triangles.count == model.vertices * 12)
        }
        let smallPreview = try VisionMeshData.preview(model: model)
        precondition(smallPreview.isMesh && smallPreview.primitiveCount == model.indices / 3,
                     "small preview models keep their complete surfaces")
        let previewStart = VisionPreviewPose()
        let previewDrag = previewStart.applying(drag: [100, -100], magnification: 1.5)
        precondition(previewDrag.yaw == 5 && previewDrag.pitch == -15 && previewDrag.zoom == 1.5)
        precondition(previewStart == VisionPreviewPose(), "live gesture updates and cancellation leave the committed pose untouched")
        precondition(previewDrag == previewStart.applying(drag: [100, -100], magnification: 1.5),
                     "repeated gesture totals must not accumulate rotation or scale")
        let previewNext = previewDrag.applying(drag: [-100, 100], magnification: 0.8)
        precondition(previewNext.yaw == -30 && previewNext.pitch == 20 && abs(previewNext.zoom - 1.2) < 0.00001,
                     "a new gesture continues from the previously committed view")
        let previewLimit = previewStart.applying(drag: [10_000, 10_000], magnification: 100)
        precondition(abs(previewLimit.yaw) <= 180 && abs(previewLimit.pitch) <= 180 && previewLimit.zoom == 2)
        let previewLowerLimit = previewLimit.applying(drag: [0, -10_000], magnification: 0.001)
        precondition(previewLowerLimit.pitch == previewStart.pitch && previewLowerLimit.zoom == 0.5,
                     "reversing a multi-turn vertical drag restores the starting angle while zoom stays bounded")
        var continuousPreview = previewStart
        for _ in 0..<72 {
            let next = continuousPreview.applying(drag: [100, 100])
            precondition((next.yaw - continuousPreview.yaw).remainder(dividingBy: 360) == 35 &&
                         (next.pitch - continuousPreview.pitch).remainder(dividingBy: 360) == 35,
                         "every new drag continues rotating both axes across poles and angle wraparound")
            continuousPreview = next
        }
        precondition(continuousPreview == previewStart, "seven complete turns restore the original view without changing zoom")
        precondition(previewStart.applying(drag: [.nan, .infinity], magnification: .nan) == previewStart,
                     "invalid gesture samples must not corrupt the preview transform")
        // A long, shallow scan must remain inside the preview's depth at every
        // angle, including at 200% zoom. A flat or signed-height layout used to
        // mirror the model and clip its middle/back as soon as it was rotated.
        let scanExtent = SIMD3<Float>(3.19, 4.54, 1.22)
        let scanDiameter = simd_length(scanExtent)
        for viewport in [SIMD3<Float>(0.608, 0.257, 0.412), SIMD3(0.2, 0.5, 0.4), SIMD3(0.8, 0.2, 0.4)] {
            let normal = VisionPreviewFraming(diameter: scanDiameter, availableSize: viewport, zoom: 1)!
            for zoom: Float in [0.5, 1, 2] {
                let framing = VisionPreviewFraming(diameter: scanDiameter, availableSize: viewport, zoom: zoom)!
                precondition(framing.scale > 0 && abs(framing.scale - normal.scale * zoom) < 0.00001,
                             "preview scaling stays positive and preserves the complete zoom range")
                for yaw in stride(from: -180, through: 180, by: 30) {
                    for pitch in stride(from: -180, through: 180, by: 30) {
                        let rotation = simd_quatf(angle: Float(pitch) * .pi / 180, axis: SIMD3(1, 0, 0))
                            * simd_quatf(angle: Float(yaw) * .pi / 180, axis: SIMD3(0, 1, 0))
                            * simd_quatf(angle: -.pi / 2, axis: SIMD3(1, 0, 0))
                        for corner in 0..<8 {
                            let signs = SIMD3<Float>(corner & 1 == 0 ? -1 : 1, corner & 2 == 0 ? -1 : 1, corner & 4 == 0 ? -1 : 1)
                            let point = rotation.act(scanExtent * signs / 2) * framing.scale + SIMD3(0, 0, framing.centerZ)
                            precondition(point.z > -viewport.z / 2 && point.z < viewport.z / 2,
                                         "every rotated corner stays between the front and back clipping planes")
                            if zoom <= 1 {
                                precondition(abs(point.x) < viewport.x / 2 && abs(point.y) < viewport.y / 2,
                                             "the entire model fits the initial preview at every rotation")
                            }
                        }
                    }
                }
            }
        }
        for invalidSize in [SIMD3<Float>.zero, SIMD3(0.6, -0.25, 0.4), SIMD3(0.6, 0.25, 0), SIMD3(.infinity, 1, 1)] {
            precondition(VisionPreviewFraming(diameter: scanDiameter, availableSize: invalidSize, zoom: 1) == nil,
                         "invalid or zero-depth geometry cannot produce a mirrored or clipped preview")
        }
        precondition(VisionPreviewFraming(diameter: 0, availableSize: SIMD3(repeating: 1), zoom: 1) == nil)
        precondition(VisionPreviewFraming(diameter: scanDiameter, availableSize: SIMD3(repeating: 1), zoom: .nan) == nil)
        let denseFixture = URL(fileURLWithPath: args[2] + "-dense")
        let denseManifest = try JSONDecoder().decode(ModelManifest.self, from: Data(contentsOf: denseFixture.appendingPathExtension("json")))
        let denseBytes = try Data(contentsOf: denseFixture.appendingPathExtension("atls"))
        let denseModel = try ModelGeometry(data: denseBytes, manifest: denseManifest)
        let densePreview = try VisionMeshData.preview(model: denseModel)
        precondition(!densePreview.isMesh && densePreview.primitiveCount == 50_000,
                     "dense scans need visible point coverage, not disconnected subpixel faces")
        let radius = (densePreview.positions[0].y - densePreview.positions[1].y) / 2
        let diagonal = simd_length(denseManifest.bounds!.max.simd - denseManifest.bounds!.min.simd)
        let fittedPointDiameter = 2 * radius * 0.82 * 280 / diagonal
        precondition(fittedPointDiameter > 1.5 && fittedPointDiameter < 2,
                     "preview points remain visible when a multi-meter scan fits in the window")
        let spatialMesh = try VisionMeshData(model: denseModel, mode: .mesh, quality: .light)
        precondition(spatialMesh.isMesh && spatialMesh.primitiveCount == 40_000 && denseModel.data == denseBytes,
                     "preview budgets must not alter spatial rendering or the original model bytes")
        let detailMesh = try VisionMeshData(model: denseModel, mode: .mesh, quality: .detail)
        precondition(detailMesh.primitiveCount == 300_000 && detailMesh.primitiveCount < denseModel.indices / 3)
        let fullMesh = try VisionMeshData(model: denseModel, mode: .mesh, quality: .full)
        precondition(fullMesh.isMesh && fullMesh.primitiveCount == denseModel.indices / 3 &&
                     fullMesh.triangles.count == denseModel.indices && fullMesh.positions.count == denseModel.indices,
                     "full quality must retain every triangle even above the detail budget")
        denseBytes.withUnsafeBytes { raw in
            func uint(_ offset: Int) -> UInt32 { UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)) }
            for corner in 0..<denseModel.indices {
                let vertex = Int(uint(32 + denseModel.vertices * 16 + corner * 4))
                let position = SIMD3(Float(bitPattern: uint(32 + vertex * 12)),
                                     Float(bitPattern: uint(36 + vertex * 12)), Float(bitPattern: uint(40 + vertex * 12)))
                precondition(fullMesh.positions[Int(fullMesh.triangles[corner])] == position,
                             "full quality preserves each source triangle's vertices, winding and absolute coordinates")
            }
        }
        let fullPoints = try VisionMeshData(model: denseModel, mode: .points, quality: .full)
        precondition(!fullPoints.isMesh && fullPoints.primitiveCount == denseModel.vertices &&
                     fullPoints.positions.count == denseModel.vertices * 4 && denseModel.data == denseBytes,
                     "full point mode must also retain all source points without mutating the model")
        var corrupt = bytes; corrupt[32] ^= 1
        do { _ = try ModelGeometry(data: corrupt, manifest: manifest); preconditionFailure("corrupt model accepted") } catch is TeachingError {}

        func api(_ path: String, method: String = "GET", token: String? = nil, body: Data? = nil) async throws -> Data {
            var request = URLRequest(url: URL(string: base + "/__atlas/ipad" + path)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            precondition((200...299).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
            return data
        }
        struct Ticket: Decodable { var id: String; var ownerToken: String; var pairingCode: String }
        let body = try JSONSerialization.data(withJSONObject: ["manifest": JSONSerialization.jsonObject(with: JSONEncoder().encode(manifest))])
        let ticket = try JSONDecoder().decode(Ticket.self, from: await api("/sessions", method: "POST", body: body))
        _ = try await api("/sessions/\(ticket.id)/model", method: "PUT", token: ticket.ownerToken, body: bytes)
        let client = try LANClient(address: base)
        let paired = try await client.pair(code: ticket.pairingCode, deviceID: UUID().uuidString, name: TeachingDevice.visionPro.model)
        let preview = try await client.modelThumbnail(paired)
        let previewSource = CGImageSourceCreateWithData(preview as CFData, nil)!
        let previewImage = CGImageSourceCreateImageAtIndex(previewSource, 0, nil)!
        precondition(previewImage.width == 384 && previewImage.height == 256 && preview.count < 512 * 1024)
        let downloaded = try await client.download(paired)
        precondition(downloaded == bytes)
        var result = TeachingResult(sessionId: paired.id, modelHash: manifest.modelHash)
        result.device = .visionPro; result.device.poseSource = "spatialAuthoring"
        result.calibrations = [first, second]; result.samples = [sample]
        var moved = device; moved.columns.3.x += 0.2
        result.samples.append(authored)
        for i in result.samples.indices { result.samples[i].name = "Vision Pose \(i + 1)" }
        let storeURL = URL(fileURLWithPath: args[3]), store = ProjectStore(directory: storeURL)
        var project = LocalProject(serverURL: base, session: paired, result: result)
        project.spatialCameraDraft = closeCamera.draft
        try await store.saveModel(downloaded, id: paired.id); try await store.save(project)
        let recovered = try await ProjectStore(directory: storeURL).projects()
        precondition(recovered.count == 1 && recovered[0].result.samples.count == 2 && recovered[0].result.device.platform == "visionOS")
        same(try VisionCameraTarget(draft: recovered[0].spatialCameraDraft!).transform, closeCamera.transform)
        let modelURL = try await store.modelURL(paired.id)
        var renamed = manifest; renamed.name = "another-name.ply"
        let matching = try await store.matchingModel(renamed)
        precondition(matching?.id == paired.id, "model content matches regardless of filename or transfer ID")
        var different = manifest; different.modelHash = String(repeating: "0", count: 64)
        let sameNameMismatch = try await store.matchingModel(different)
        precondition(sameNameMismatch == nil, "the same filename cannot substitute for content verification")
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("unfinished result uploaded") } catch is TeachingError {}
        project.result.completedAt = timestamp(); try await store.save(project)
        try await store.saveModel(corrupt, id: paired.id)
        let corruptedMatch = try await store.matchingModel(manifest)
        precondition(corruptedMatch == nil, "metadata cannot hide actual local file corruption")
        do { try await client.upload(project, modelURL: modelURL); preconditionFailure("mismatched model uploaded") } catch is TeachingError {}
        try await store.saveModel(bytes, id: paired.id)
        try FileManager.default.removeItem(at: modelURL)
        let missingMatch = try await store.matchingModel(manifest)
        precondition(missingMatch == nil, "a stale project record without its file is a cache miss")
        try await store.saveModel(bytes, id: paired.id)
        try await client.upload(project, modelURL: modelURL)
        try await client.upload(project, modelURL: modelURL)
        let returned = try JSONDecoder().decode(TeachingResult.self, from: await api("/sessions/\(ticket.id)/result", token: ticket.ownerToken))
        precondition(returned.id == project.result.id && returned.samples.count == 2 && returned.device.platform == "visionOS")
        try JSONEncoder().encode(returned).write(to: URL(fileURLWithPath: args[4]))
        print("Vision Pro: rigid transforms, optical axes, refined placement, mesh/point rendering, pairing, offline recovery, model checks and idempotent sync passed.")
    }
}
