import Foundation
import SceneKit
import Metal
import CryptoKit
import AppKit

@main struct TeachingCoverageTests {
    static func model(_ points: [SIMD3<Float>], _ indices: [UInt32]) throws -> ModelGeometry {
        var data = Data(count: 32 + points.count * 16 + indices.count * 4)
        data.withUnsafeMutableBytes { raw in
            let words = raw.bindMemory(to: UInt32.self)
            words[0] = 0x534c5441; words[1] = 1; words[2] = UInt32(points.count); words[3] = UInt32(indices.count)
            for (index, point) in points.enumerated() {
                for axis in 0..<3 { words[8 + index * 3 + axis] = point[axis].bitPattern }
                words[8 + points.count * 3 + index] = 0xff808080
            }
            for (index, value) in indices.enumerated() { words[8 + points.count * 4 + index] = value }
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return try ModelGeometry(data: data, manifest: ModelManifest(protocol: teachingProtocol, modelHash: hash,
            name: "coverage-test", sourceHash: hash, sourceMapId: "coverage-test", coordinateFrame: "virtual_origin",
            distanceUnit: "meter", verticalAxis: "Z", vertices: points.count, indices: indices.count,
            sampled: false, originalVertices: points.count, byteLength: data.count,
            bounds: ModelBounds(min: Point3(SIMD3(-3, -3, -3)), max: Point3(SIMD3(3, 3, 3)))))
    }
    static func plane(z: Float, radius: Float = 2) -> [SIMD3<Float>] {
        [SIMD3(-radius, -radius, z), SIMD3(radius, -radius, z), SIMD3(radius, radius, z), SIMD3(-radius, radius, z)]
    }
    static let quad: [UInt32] = [0, 1, 2, 0, 2, 3]
    static func camera(position: SIMD3<Float> = .zero, rotation: simd_quatf = simd_quatf(angle: 0, axis: SIMD3(0, 1, 0))) -> CameraPose {
        CameraPose(position: Point3(position), quaternion: Rotation4(rotation))
    }
    @MainActor static func main() async throws {
        guard let device = MTLCreateSystemDefaultDevice() else { fatalError("Coverage tests require Metal") }
        let pose = TeachingCoveragePose(camera())!
        let legacy = TeachingSample(segmentId: "legacy", kind: "keyframe", cameraPose: camera())
        let legacyBytes = try JSONEncoder().encode(legacy)
        let decodedLegacy = try JSONDecoder().decode(TeachingSample.self, from: legacyBytes)
        precondition(decodedLegacy.origin == nil && decodedLegacy.resolvedOrigin == .ipad)
        precondition(!String(data: legacyBytes, encoding: .utf8)!.contains("origin"), "legacy archives stay compatible")
        var imported = legacy; imported.origin = .desktop
        var oldLeft = imported; oldLeft.name = "Pose 001 · 左相机"
        var oldRight = imported; oldRight.name = "Pose 001 · 右相机"
        precondition(oldLeft.resolvedArm == .left && oldRight.resolvedArm == .right)
        oldRight.arm = oldRight.resolvedArm; oldRight.name = "Renamed"
        let armRoundTrip = try JSONDecoder().decode(TeachingSample.self, from: JSONEncoder().encode(oldRight))
        precondition(armRoundTrip.category == .rightArm, "explicit arm identity survives rename and storage")
        var namedIPad = legacy; namedIPad.name = "Pose 001 · 左相机"
        precondition(namedIPad.category == .ipad, "an iPad pose cannot be classified by name")
        let armCounts = TeachingPoseCounts([oldLeft, oldRight, legacy, oldLeft, oldRight, oldLeft, oldRight])
        precondition(armCounts[.leftArm] == 3 && armCounts[.rightArm] == 3 && armCounts[.ipad] == 1)
        var returningIPad = legacy; returningIPad.id = "returning-ipad"; returningIPad.origin = .ipad
        let seed = TeachingPoseSeed(samples: [imported, returningIPad])
        var seededResult = TeachingResult(sessionId: "seed-test", modelHash: "model-test")
        try seed.apply(to: &seededResult)
        let restored = try JSONDecoder().decode(TeachingResult.self, from: JSONEncoder().encode(seededResult))
        precondition(restored.samples[0].resolvedOrigin == .desktop
                     && restored.samples[0].segmentId == restored.calibrations[0].id)
        precondition(restored.samples[1].origin == .ipad, "an iPad Pose keeps its source after transmission through Mac")
        let flat = try model(plane(z: 1), quad)
        let engine = try TeachingCoverageEngine(model: flat)
        let depths = try await engine.rasterize(pose)
        precondition(depths.count == 28 * 18 && depths.allSatisfy { abs($0 - 1) < 0.00001 },
                     "a large triangle crossing the frustum covers its interior even when every source vertex is outside")
        for point in [SIMD3<Float>(0, 0, 1), SIMD3(0.45, 0.2, 1)] {
            precondition(TeachingCoverageProfile.contains(point, depths: depths))
        }
        for point in [SIMD3<Float>(0.7, 0, 1), SIMD3(0, 0.5, 1), SIMD3(0, 0, -1), SIMD3(0, 0, 1.4), SIMD3(0, 0, 0.2)] {
            precondition(!TeachingCoverageProfile.contains(point, depths: depths), "FOV, front direction and M70 range are enforced")
        }
        let stacked = try model(plane(z: 0.7, radius: 0.15) + plane(z: 1), quad + quad.map { $0 + 4 })
        let stackedEngine = try TeachingCoverageEngine(model: stacked)
        let occlusion = try await stackedEngine.rasterize(pose)
        precondition(TeachingCoverageProfile.contains(SIMD3(0, 0, 0.7), depths: occlusion))
        precondition(!TeachingCoverageProfile.contains(SIMD3(0, 0, 1), depths: occlusion), "rear surfaces cannot leak through the foreground")
        precondition(TeachingCoverageProfile.contains(SIMD3(0.4, 0, 1), depths: occlusion), "visible rear surface beside an occluder remains covered")
        let tooNear = try model(plane(z: 0.1) + plane(z: 1), quad + quad.map { $0 + 4 })
        let nearEngine = try TeachingCoverageEngine(model: tooNear)
        let nearGrid = try await nearEngine.rasterize(pose)
        precondition(!TeachingCoverageProfile.contains(SIMD3(0, 0, 1), depths: nearGrid),
                     "occluders closer than M70 workingNear must still block surfaces behind them")
        let distant = try model(plane(z: 2), quad)
        let emptyEngine = try TeachingCoverageEngine(model: distant)
        let empty = try await emptyEngine.rasterize(pose)
        precondition(empty.allSatisfy { $0 == 0 }, "empty cells never extend to the far plane")
        let missing = try await emptyEngine.build([pose])
        precondition(missing.frameCount == 0 && missing.frames == nil)
        guard case .tooFar(let farDepth) = missing.poseStatuses[pose] else { fatalError("a distant visible surface must explain a missed footprint") }
        precondition(abs(farDepth - 2) < 0.001)
        let tooNearSnapshot = try await nearEngine.build([pose])
        guard case .tooNear(let nearDepth) = tooNearSnapshot.poseStatuses[pose] else { fatalError("near occluders must report that the camera is too close") }
        precondition(abs(nearDepth - 0.1) < 0.001 && tooNearSnapshot.frameCount == 0)
        let sideways = TeachingCoveragePose(camera(position: SIMD3(10, 0, 0)))!
        let outsideSnapshot = try await engine.build([sideways])
        precondition(outsideSnapshot.poseStatuses[sideways] == .outsideView && outsideSnapshot.frameCount == 0,
                     "a model outside the camera frustum must not be reported as a distance miss")
        var previewSample = TeachingSample(segmentId: "preview", kind: "keyframe", cameraPose: camera())
        let distantPreview = try await emptyEngine.preview(previewSample)
        precondition(distantPreview.frameCount == 0,
                     "Pose inspection and desktop capture share M70's working range")
        previewSample.previewCameraTransform = TeachingCoordinates.opticalToARCamera.elements
        previewSample.previewProjection = [4, 0, 0, 0, 0, 4, 0, 0, 0.3, -0.2, -1.000001, -1, 0, 0, -0.001000001, 0]
        previewSample.previewCameraTransform![12] = 3
        previewSample.previewAspect = 4 / 3
        let savedSample = try JSONEncoder().encode(previewSample)
        let offAxis = try await engine.preview(previewSample)
        let offAxisBounds = offAxis.modelBounds!
        precondition(abs(Float(offAxisBounds.0.x) + TeachingCoverageProfile.tangentX) < 0.0001
                     && abs(Float(offAxisBounds.1.y) - TeachingCoverageProfile.tangentY) < 0.0001,
                     "old iPad preview lens and screen transform cannot alter the M70 frame at the saved optical Pose")
        let unchangedSample = try JSONEncoder().encode(previewSample)
        let savedObject = try JSONSerialization.jsonObject(with: savedSample) as! NSDictionary
        let unchangedObject = try JSONSerialization.jsonObject(with: unchangedSample) as! NSDictionary
        precondition(savedObject == unchangedObject,
                     "reinterpreting old previews does not rewrite saved samples")

        let q = simd_quatf(angle: 0.76, axis: simd_normalize(SIMD3<Float>(1, 2, 3)))
        let movedPose = TeachingCoveragePose(camera(position: SIMD3(0.8, -0.3, 0.4), rotation: q))!
        let fromCamera = movedPose.cameraFromModel.inverse
        let rotated = plane(z: 1).map { p -> SIMD3<Float> in
            let v = fromCamera * SIMD4(p, 1); return SIMD3(v.x, v.y, v.z)
        }
        let rotatedEngine = try TeachingCoverageEngine(model: model(rotated, quad))
        let rotatedGrid = try await rotatedEngine.rasterize(movedPose)
        precondition(rotatedGrid.allSatisfy { abs($0 - 1) < 0.00001 }, "arbitrary model-relative camera tilt and translation retain the footprint")

        let point = SIMD3((Float(14.5 / 28 * 2 - 1)) * TeachingCoverageProfile.tangentX,
                          (Float(9.5 / 18 * 2 - 1)) * TeachingCoverageProfile.tangentY, 1)
        let pointEngine = try TeachingCoverageEngine(model: model([point], []))
        let pointGrid = try await pointEngine.rasterize(pose)
        precondition(TeachingCoverageProfile.contains(point, depths: pointGrid), "legacy point-only models are supported")
        for malformed in [try model(plane(z: 1), [0, 1, 99]), try model([SIMD3(.nan, 0, 1)], [])] {
            let invalidEngine = try TeachingCoverageEngine(model: malformed)
            do { _ = try await invalidEngine.rasterize(pose); fatalError("invalid model geometry must not produce coverage") }
            catch is TeachingError {}
        }
        var invalidCamera = camera(); invalidCamera.position.x = .nan
        precondition(TeachingCoveragePose(invalidCamera) == nil)

        // Exercise the actual SceneKit Metal shader and read rendered pixels:
        // this catches buffer bindings, interpolation and union/opacity errors.
        let renderer = SCNRenderer(device: device, options: nil)
        let scene = SCNScene(); scene.background.contents = NSColor.black
        let geometry = try flat.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        let node = SCNNode(geometry: geometry); scene.rootNode.addChildNode(node)
        let cameraNode = SCNNode(); cameraNode.camera = SCNCamera()
        cameraNode.camera?.usesOrthographicProjection = true; cameraNode.camera?.orthographicScale = 1.2
        cameraNode.position = SCNVector3(0, 0, 3); scene.rootNode.addChildNode(cameraNode)
        renderer.scene = scene; renderer.pointOfView = cameraNode
        func capture(_ filename: String? = nil) -> [UInt8] {
            let shot = renderer.snapshot(atTime: 0, with: CGSize(width: 256, height: 256), antialiasingMode: .none)
            let cg = shot.cgImage(forProposedRect: nil, context: nil, hints: nil)!
            var pixels = [UInt8](repeating: 0, count: 256 * 256 * 4)
            pixels.withUnsafeMutableBytes { raw in
                let context = CGContext(data: raw.baseAddress, width: 256, height: 256, bitsPerComponent: 8,
                    bytesPerRow: 1024, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
                context.draw(cg, in: CGRect(x: 0, y: 0, width: 256, height: 256))
            }
            if let filename, let directory = CommandLine.arguments.dropFirst().first {
                try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!
                    .write(to: URL(fileURLWithPath: directory).appendingPathComponent(filename))
            }
            return pixels
        }
        let plain = capture()
        let snapshot = try await engine.build([pose])
        let firstFraction = snapshot.coveredFraction!
        let apertureArea = 4 * Double(TeachingCoverageProfile.tangentX * TeachingCoverageProfile.tangentY)
        precondition(abs(firstFraction - apertureArea / 16) < 0.002,
                     "coverage measures partial triangle AREA, even with every vertex outside the view")
        precondition(snapshot.categoryFractions[.ipad] == firstFraction
                     && snapshot.categoryFractions[.leftArm] == 0 && snapshot.categoryFractions[.rightArm] == 0,
                     "each group uses the whole model area as its denominator")
        let shiftedPose = TeachingCoveragePose(camera(position: SIMD3(0.2, 0, 0)))!
        let union = try await engine.build([pose, shiftedPose])
        let unionArea = (2 * Double(TeachingCoverageProfile.tangentX) + 0.2) * 2 * Double(TeachingCoverageProfile.tangentY)
        precondition(abs(union.coveredFraction! - unionArea / 16) < 0.002
                     && union.coveredFraction! > firstFraction && union.coveredFraction! < 2 * firstFraction,
                     "overlapping footprints count only their union, not the sum of their areas")
        let selectedCoverage = try await engine.preview(previewSample)
        precondition(selectedCoverage.coveredFraction == firstFraction
                     && selectedCoverage.coveredFraction! < union.coveredFraction!,
                     "Pose details report only the selected camera's area over the full model")
        precondition(offAxis.coveredFraction == firstFraction && distantPreview.coveredFraction == 0,
                     "legacy screen lens fields do not change the M70 percentage, and misses report zero")
        let untouchedUnion = try await engine.build([pose, shiftedPose])
        precondition(untouchedUnion.coveredFraction == union.coveredFraction
                     && untouchedUnion.categoryFractions == union.categoryFractions,
                     "inspecting one Pose cannot replace the accumulated union or group statistics")
        var editedPreview = previewSample
        editedPreview.cameraPose = camera(position: SIMD3(0, 0, -1))
        let editedCoverage = try await engine.preview(editedPreview)
        let restoredCoverage = try await engine.preview(previewSample)
        precondition(editedCoverage.coveredFraction == 0 && restoredCoverage.coveredFraction == firstFraction,
                     "selection measurement is keyed by the camera, not an unchanged sample ID")
        let freshEngine = try TeachingCoverageEngine(model: flat)
        let reordered = try await freshEngine.build([shiftedPose, pose, shiftedPose])
        precondition(reordered.coveredFraction == union.coveredFraction && reordered.categoryFractions == union.categoryFractions,
                     "duplicate/reordered Poses and reopening keep exactly the same estimate")
        let deleted = try await engine.build([shiftedPose])
        let onePose = try await freshEngine.build([shiftedPose])
        precondition(deleted.coveredFraction == onePose.coveredFraction && deleted.coveredFraction! < union.coveredFraction!,
                     "deletion recomputes the retained union without leaving removed coverage behind")
        let batched = try await freshEngine.build(Array(repeating: pose, count: 65) + [shiftedPose])
        precondition(batched.coveredFraction == union.coveredFraction && batched.categoryFractions == union.categoryFractions,
                     "GPU batch boundaries must preserve the same union without counting overlap again")
        let zero = try await engine.build([])
        precondition(zero.coveredFraction == 0 && zero.categoryFractions.values.allSatisfy { $0 == 0 })
        let unequalArea = try TeachingCoverageEngine(model: model(plane(z: 1, radius: 0.1) + plane(z: 2, radius: 1),
                                                                 quad + quad.map { $0 + 4 }))
        let weighted = try await unequalArea.build([pose])
        precondition(abs(weighted.coveredFraction! - 0.04 / 4.04) < 0.001,
                     "equal numbers of faces with unequal areas must not each contribute 50 percent")
        let pointCoverage = try await pointEngine.build([pose])
        let selectedPoints = try await pointEngine.preview(previewSample)
        let selectedWeighted = try await unequalArea.preview(previewSample)
        let selectedTooNear = try await nearEngine.preview(previewSample)
        precondition(selectedPoints.coveredFraction == 1 && selectedWeighted.coveredFraction == weighted.coveredFraction
                     && selectedTooNear.coveredFraction == 0,
                     "single-Pose percentages preserve point-cloud fallback, area weights and near occluders")
        precondition(pointCoverage.coveredFraction == 1 && missing.coveredFraction == 0 && tooNearSnapshot.coveredFraction == 0,
                     "point-only coverage and out-of-range surfaces follow the same visibility rules")
        precondition(pointCoverage.categoryFractions[.ipad] == 1 && missing.categoryFractions[.ipad] == 0
                     && tooNearSnapshot.categoryFractions[.ipad] == 0)
        TeachingCoverageRenderer.apply(snapshot, opacity: 0.5, to: geometry.firstMaterial!)
        let tinted = capture("coverage-surface.png")
        let center = (128 * 256 + 128) * 4
        precondition(Int(tinted[center + 2]) > Int(tinted[center]) + 15, "legacy and new iPad Poses tint the triangle interior purple")
        precondition(tinted[center + 3] == plain[center + 3], "source alpha is preserved")
        let outside = (128 * 256 + 240) * 4
        precondition(Array(tinted[outside..<(outside + 4)]) == Array(plain[outside..<(outside + 4)]), "outside-FOV surface color remains unchanged")
        let macPose = TeachingCoveragePose(camera(), origin: .desktop)!
        let green = try await engine.build([macPose])
        precondition(green.coveredFraction == snapshot.coveredFraction && green.ipadFrameCount == 0)
        TeachingCoverageRenderer.apply(green, opacity: 1, to: geometry.firstMaterial!)
        let greenPixels = capture("mac-coverage-surface.png")
        precondition(Int(greenPixels[center + 1]) > Int(greenPixels[center]) + 30,
                     "Mac coverage must retain the original green in the Metal shader")
        let both = try await engine.build([macPose, pose])
        precondition(both.coveredFraction == snapshot.coveredFraction && both.ipadFrameCount == 1,
                     "the same footprint from two sources is never double-counted")
        TeachingCoverageRenderer.apply(both, opacity: 1, to: geometry.firstMaterial!)
        let overlapPixels = capture("overlapping-origins.png")
        precondition(Int(overlapPixels[center + 2]) > Int(overlapPixels[center]) + 20,
                     "iPad coverage wins overlap even when Mac appears first")
        let mixed = try await engine.build([TeachingCoveragePose(camera(position: SIMD3(0.7, 0, 0)), origin: .desktop)!, pose])
        TeachingCoverageRenderer.apply(mixed, opacity: 1, to: geometry.firstMaterial!)
        let mixedPixels = capture("mixed-origins.png"), right = (128 * 256 + 224) * 4
        precondition(Int(mixedPixels[right + 1]) > Int(mixedPixels[right]) + 40
                     && Int(mixedPixels[center + 2]) > Int(mixedPixels[center]) + 20,
                     "legacy Mac and purple iPad surfaces coexist")
        for (arm, expected) in [(TeachingPoseArm.left, [89, 219, 232]), (.right, [244, 201, 93])] {
            let armPose = TeachingCoveragePose(camera(), origin: .desktop, arm: arm)!
            let armSnapshot = try await engine.build([armPose])
            precondition(armSnapshot.leftArmFrameCount == (arm == .left ? 1 : 0)
                         && armSnapshot.rightArmFrameCount == (arm == .right ? 1 : 0))
            TeachingCoverageRenderer.apply(armSnapshot, opacity: 1, to: geometry.firstMaterial!)
            let pixels = capture("\(arm.rawValue)-arm-coverage.png")
            for channel in 0..<3 {
                precondition(abs(Int(pixels[center + channel]) - expected[channel]) <= 4,
                             "\(arm.rawValue) arm shader matches Mac sRGB: \(Array(pixels[center..<(center + 3)]))")
            }
        }
        let armOverlap = try await engine.build([TeachingCoveragePose(camera(), origin: .desktop, arm: .left)!,
                                                TeachingCoveragePose(camera(), origin: .desktop, arm: .right)!])
        precondition(armOverlap.coveredFraction == snapshot.coveredFraction, "left/right overlap is counted only once")
        precondition(armOverlap.categoryFractions[.leftArm] == firstFraction
                     && armOverlap.categoryFractions[.rightArm] == firstFraction,
                     "left and right each include their full coverage despite overlapping color priority")
        let leftPose = TeachingCoveragePose(camera(), origin: .desktop, arm: .left)!
        let rightPose = TeachingCoveragePose(camera(), origin: .desktop, arm: .right)!
        let shiftedLeft = TeachingCoveragePose(camera(position: SIMD3(0.2, 0, 0)), origin: .desktop, arm: .left)!
        let groupedEngine = try TeachingCoverageEngine(model: flat)
        _ = try await groupedEngine.build([leftPose])
        let grouped = try await groupedEngine.build([leftPose, shiftedLeft, shiftedLeft, rightPose, pose, macPose])
        precondition(grouped.coveredFraction == union.coveredFraction
                     && grouped.categoryFractions[.leftArm] == union.coveredFraction,
                     "partial overlap and duplicates within a group use its union, not intersection or summed area")
        for category in [TeachingPoseCategory.rightArm, .ipad, .desktop] {
            precondition(grouped.categoryFractions[category] == firstFraction,
                         "new categories mark samples even when an earlier category already covered them")
        }
        precondition(grouped.categoryFractions.values.reduce(0, +) > grouped.coveredFraction!)
        let reorderedGroups = try await groupedEngine.build([macPose, pose, shiftedLeft, rightPose, leftPose])
        precondition(reorderedGroups.categoryFractions == grouped.categoryFractions)
        let deletedGroupPose = try await groupedEngine.build([leftPose, rightPose, pose, macPose])
        precondition(deletedGroupPose.categoryFractions.values.allSatisfy { $0 == firstFraction },
                     "removing a Pose shrinks only its group's union while retaining cross-group overlap")
        _ = try await groupedEngine.build([leftPose])
        let reassigned = try await groupedEngine.build([rightPose])
        precondition(reassigned.coveredFraction == firstFraction && reassigned.categoryFractions[.leftArm] == 0
                     && reassigned.categoryFractions[.rightArm] == firstFraction,
                     "recategorizing an unchanged camera clears the old group")
        let groupedBatches = try await groupedEngine.build(Array(repeating: leftPose, count: 65) + [shiftedLeft, rightPose, pose, macPose])
        precondition(groupedBatches.coveredFraction == grouped.coveredFraction
                     && groupedBatches.categoryFractions == grouped.categoryFractions,
                     "all category bits survive multiple GPU batches")
        let fullGroups = try await pointEngine.build([leftPose, rightPose, pose, macPose])
        precondition(fullGroups.coveredFraction == 1 && fullGroups.categoryFractions.values.allSatisfy { $0 == 1 },
                     "groups may sum to more than 100 percent while total coverage never does")
        let armPreview = try await engine.preview(oldRight)
        precondition(armPreview.rightArmFrameCount == 1 && armPreview.coveredFraction == firstFraction,
                     "selected Pose surface retains right-arm color without changing its area")
        let sourceUnion = try await engine.build([TeachingCoveragePose(camera(position: SIMD3(0.2, 0, 0)), origin: .desktop)!, pose])
        precondition(sourceUnion.coveredFraction == union.coveredFraction, "coverage union is independent of Pose source")
        let macPreview = try await engine.preview(imported)
        precondition(macPreview.ipadFrameCount == 0 && macPreview.frameCount == 1, "Pose inspection retains origin color")
        TeachingCoverageRenderer.apply(snapshot, opacity: 0, to: geometry.firstMaterial!, clipOutside: true)
        let clipped = capture("pose-local-surface.png")
        precondition(Array(clipped[center..<(center + 4)]) == Array(plain[center..<(center + 4)]),
                     "the selected Pose keeps its original surface color")
        precondition(clipped[outside] == 0 && clipped[outside + 1] == 0 && clipped[outside + 2] == 0,
                     "surfaces outside the selected Pose disappear even when the inspecting camera sees them")
        let localBounds = snapshot.modelBounds!
        precondition(abs(Float(localBounds.0.x) + TeachingCoverageProfile.tangentX) < 0.0001
                     && abs(Float(localBounds.1.y) - TeachingCoverageProfile.tangentY) < 0.0001,
                     "the orbit bounds follow the selected surface, not the original model bounds")
        let repeated = try await engine.build([pose, pose])
        precondition(repeated.coveredFraction == firstFraction, "repeated coverage is never counted twice")
        TeachingCoverageRenderer.apply(repeated, opacity: 0.5, to: geometry.firstMaterial!)
        let overlapped = capture()
        precondition(Array(overlapped[center..<(center + 4)]) == Array(tinted[center..<(center + 4)]), "overlapping poses are a binary union, never darker or brighter")
        node.geometry = try stacked.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        let stackedSnapshot = try await stackedEngine.build([pose])
        let selectedStacked = try await stackedEngine.preview(previewSample)
        precondition(selectedStacked.coveredFraction == stackedSnapshot.coveredFraction,
                     "selected and aggregate percentages share the same surface occlusion tolerance")
        let backPlain = capture()
        TeachingCoverageRenderer.apply(stackedSnapshot, opacity: 0.5, to: node.geometry!.firstMaterial!)
        let backTinted = capture("coverage-occlusion.png")
        precondition(Array(backPlain[center..<(center + 4)]) == Array(backTinted[center..<(center + 4)]), "a view from behind must not reveal tint through the model")
        node.geometry = try flat.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        TeachingCoverageRenderer.apply(stackedSnapshot, opacity: 0, to: node.geometry!.firstMaterial!, clipOutside: true)
        let clippedBack = capture("pose-local-occlusion.png")
        precondition(clippedBack[center] == 0 && clippedBack[center + 1] == 0 && clippedBack[center + 2] == 0,
                     "rotating behind the selected Pose cannot reveal a rear surface hidden in the recorded view")
        node.geometry = try flat.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        TeachingCoverageRenderer.apply(offAxis, opacity: 0, to: node.geometry!.firstMaterial!, clipOutside: true)
        let recordedFrustum = capture("pose-recorded-frustum.png")
        precondition(recordedFrustum[center] > 0 && recordedFrustum[outside] == 0,
                     "the actual preview shader uses the unified M70 projection and its higher depth resolution")

        let display = TeachingCoverageRenderer()
        let sample = TeachingSample(segmentId: "test", kind: "keyframe", cameraPose: camera())
        display.attach(to: geometry); display.update(model: flat, samples: [sample, sample])
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.error.isEmpty && !display.preparing && display.poseCount == 2 && display.hitCount == 1)
        precondition(display.latestPoseStatus == .covered)
        let initialProgress = display.coveredFraction
        precondition(initialProgress == firstFraction && display.categoryFractions[.ipad] == firstFraction
                     && display.categoryPercentages[.ipad] == display.coveragePercentage
                     && display.categoryPercentages[.leftArm] == "0%")
        display.opacity = 1
        precondition(display.coveredFraction == initialProgress, "opacity changes appearance, not coverage")
        let failedSample = TeachingSample(segmentId: "test", kind: "keyframe", cameraPose: camera(position: SIMD3(0, 0, -1)))
        display.update(model: flat, samples: [sample, failedSample])
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        guard case .tooFar(let latestDepth) = display.latestPoseStatus else { fatalError("a new failed Pose must report its own result even when an earlier Pose was covered") }
        precondition(abs(latestDepth - 2) < 0.001 && display.hitCount == 1 && display.hasCoverageWarning)
        precondition(geometry.firstMaterial!.shaderModifiers != nil, "a failed new Pose preserves all previous surface coloring")
        let another = TeachingSample(segmentId: "another-segment", kind: "keyframe", cameraPose: camera(position: SIMD3(0.1, 0, 0)))
        display.update(model: flat, samples: [sample, failedSample, another])
        precondition(display.hitCount == 1 && geometry.firstMaterial!.shaderModifiers != nil,
                     "adding a pose retains the previous union while the new footprint is being prepared")
        display.cancel(); display.resume()
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.error.isEmpty && !display.preparing && display.hitCount == 2,
                     "foreground resume must finish a pending footprint even if an older union is already visible")
        let replacement = try flat.makeGeometry(settings: ModelDisplaySettings(mode: .points))
        display.attach(to: replacement)
        precondition(replacement.firstMaterial!.shaderModifiers != nil && display.hitCount == 2,
                     "quality or render-mode changes reuse the same full-model coverage")
        display.attach(to: geometry)
        display.enabled = false
        let hiddenPose = TeachingSample(segmentId: "hidden", kind: "keyframe", cameraPose: camera(position: SIMD3(0.2, 0, 0)))
        display.update(model: flat, samples: [sample, hiddenPose])
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.coveredFraction == union.coveredFraction && display.coveredFraction! > initialProgress!,
                     "recording still updates progress when the color overlay is hidden")
        let inspection = try await display.previewSnapshot(for: sample)
        precondition(inspection.frameCount == 1 && inspection.modelBounds != nil && inspection.coveredFraction == firstFraction
                     && display.coveredFraction == union.coveredFraction,
                     "single-Pose selection works while aggregate coverage is disabled")
        precondition(geometry.firstMaterial!.shaderModifiers == nil,
                     "preparing a preview never enables or replaces the live model coverage")
        precondition(geometry.firstMaterial!.shaderModifiers == nil, "hiding coverage restores original rendering")
        var leftSample = sample; leftSample.origin = .desktop; leftSample.arm = .left
        display.update(model: flat, samples: [sample, hiddenPose, leftSample])
        display.cancel(); display.resume()
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.error.isEmpty && !display.preparing && display.categoryFractions[.leftArm] == firstFraction
                     && display.categoryFractions[.ipad] == union.coveredFraction,
                     "published group statistics update across source additions, cancellation and hidden overlays")
        display.update(model: flat, samples: [leftSample])
        precondition(display.categoryPercentages[.ipad] == "—", "removal cannot display stale category totals")
        for _ in 0..<500 { if !display.preparing { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        precondition(display.categoryFractions[.ipad] == 0 && display.categoryFractions[.leftArm] == firstFraction)
        display.enabled = true
        display.update(model: flat, samples: [])
        try await Task.sleep(nanoseconds: 100_000_000)
        precondition(display.poseCount == 0 && display.hitCount == 0 && geometry.firstMaterial!.shaderModifiers == nil,
                     "deleting the last pose cancels stale work and clears the surface")
        precondition(display.coveredFraction == 0 && display.coveragePercentage == "0%"
                     && display.categoryPercentages.values.allSatisfy { $0 == "0%" })
        print("M70 surface coverage: GPU occlusion, FOV/range, shader pixels, area-weighted coverage, per-category unions and overlap, partial triangles, overlap/duplicate/order/batch invariance, hidden-overlay updates, point clouds and delete/cancel passed.")
    }
}
