import Foundation
import Combine
import Metal
import SceneKit
import simd

/// A model-relative optical pose. Names, calibration segments and screen
/// orientation do not change the footprint of an already recorded camera.
struct TeachingCoveragePose: Hashable {
    let position: SIMD3<Float>
    let quaternion: SIMD4<Float>
    let origin: TeachingPoseOrigin
    let arm: TeachingPoseArm?

    init?(_ camera: CameraPose, origin: TeachingPoseOrigin = .ipad, arm: TeachingPoseArm? = nil) {
        let p = camera.position.simd, q = camera.quaternion
        let vector = SIMD4(q.x, q.y, q.z, q.w)
        let length = simd_length_squared(vector)
        guard camera.frameName == "ipad_camera_optical_frame",
              (0..<3).allSatisfy({ p[$0].isFinite }), (0..<4).allSatisfy({ vector[$0].isFinite }),
              length.isFinite, length > 0.000001 else { return nil }
        let normalized = simd_normalize(vector)
        position = p; quaternion = normalized.w < 0 ? -normalized : normalized
        self.origin = origin
        self.arm = origin == .desktop ? arm : nil
    }

    var cameraFromModel: simd_float4x4 {
        var modelFromCamera = simd_float4x4(simd_quatf(vector: quaternion))
        modelFromCamera.columns.3 = SIMD4(position, 1)
        return modelFromCamera.inverse
    }

    var category: TeachingPoseCategory {
        guard origin == .desktop else { return .ipad }
        switch arm {
        case .left: return .leftArm
        case .right: return .rightArm
        case nil: return .desktop
        }
    }
}

private extension TeachingPoseCategory {
    var coverageMask: UInt8 {
        switch self {
        case .leftArm: return 1
        case .rightArm: return 2
        case .ipad: return 4
        case .desktop: return 8
        }
    }
}

struct TeachingCoverageMeasurement {
    let fraction: Double
    let categoryFractions: [TeachingPoseCategory: Double]

    static let zero = TeachingCoverageMeasurement(fraction: 0,
        categoryFractions: Dictionary(uniqueKeysWithValues: TeachingPoseCategory.allCases.map { ($0, 0) }))
}

enum TeachingCoverageProfile {
    // Twice the desktop depth-envelope resolution in each direction. The
    // footprint itself is evaluated per fragment, not per model vertex.
    static let columns = 28, rows = 18
    static let near = ZividFieldOfView.near, far = ZividFieldOfView.far
    static let tangentX = ZividFieldOfView.tangentX
    static let tangentY = ZividFieldOfView.tangentY
    static let rasterNear: Float = 0.001

    static func contains(_ point: SIMD3<Float>, depths: [Float]) -> Bool {
        guard point.z >= near, point.z <= far, depths.count == columns * rows else { return false }
        let normalized = SIMD2(point.x / (point.z * tangentX), point.y / (point.z * tangentY))
        guard abs(normalized.x) <= 1, abs(normalized.y) <= 1 else { return false }
        let column = min(columns - 1, max(0, Int((normalized.x + 1) * 0.5 * Float(columns))))
        let row = min(rows - 1, max(0, Int((normalized.y + 1) * 0.5 * Float(rows))))
        let depth = depths[row * columns + column]
        guard depth >= near else { return false }
        let cell = SIMD2(2 * tangentX * depth / Float(columns), 2 * tangentY * depth / Float(rows))
        let tolerance = min(Float(0.12), max(0.018, depth * 0.025, simd_length(cell) * 0.72))
        return point.z <= depth + tolerance
    }
}

enum TeachingCoveragePoseStatus: Equatable {
    case covered
    case tooNear(Float)
    case tooFar(Float)
    case outsideView

    init(depths: [Float]) {
        if depths.contains(where: { $0 >= TeachingCoverageProfile.near && $0 <= TeachingCoverageProfile.far }) {
            self = .covered
        } else if let nearest = depths.filter({ $0 > 0 && $0.isFinite }).min() {
            self = nearest < TeachingCoverageProfile.near ? .tooNear(nearest) : .tooFar(nearest)
        } else { self = .outsideView }
    }
}

struct TeachingCoverageSnapshot {
    let frames: MTLBuffer?
    let depths: MTLBuffer?
    let frameCount: Int
    let ipadFrameCount: Int
    let leftArmFrameCount: Int
    let rightArmFrameCount: Int
    let frustum: TeachingCoverageFrustum
    let poseStatuses: [TeachingCoveragePose: TeachingCoveragePoseStatus]
    let coveredFraction: Double?
    let categoryFractions: [TeachingPoseCategory: Double]

    init(frames: MTLBuffer?, depths: MTLBuffer?, frameCount: Int, frustum: TeachingCoverageFrustum = .teaching,
         poseStatuses: [TeachingCoveragePose: TeachingCoveragePoseStatus] = [:], coveredFraction: Double? = nil,
         categoryFractions: [TeachingPoseCategory: Double] = [:],
         ipadFrameCount: Int? = nil, leftArmFrameCount: Int = 0, rightArmFrameCount: Int = 0) {
        self.frames = frames; self.depths = depths; self.frameCount = frameCount; self.frustum = frustum
        self.poseStatuses = poseStatuses; self.coveredFraction = coveredFraction
        self.categoryFractions = categoryFractions
        self.ipadFrameCount = ipadFrameCount ?? frameCount
        self.leftArmFrameCount = leftArmFrameCount; self.rightArmFrameCount = rightArmFrameCount
    }

    /// Bounds of the visible depth cells, in model coordinates. The inspection
    /// pivot must follow the selected surface rather than the entire model.
    var modelBounds: (SCNVector3, SCNVector3)? {
        guard frameCount > 0, let frames, let depths else { return nil }
        let matrices = frames.contents().bindMemory(to: simd_float4x4.self, capacity: frameCount)
        let columns = frustum.columns, rows = frustum.rows
        let values = depths.contents().bindMemory(to: Float.self, capacity: frameCount * columns * rows)
        var lower = SIMD3<Float>(repeating: .infinity), upper = SIMD3<Float>(repeating: -.infinity)
        for frame in 0..<frameCount {
            let modelFromCamera = matrices[frame].inverse
            for row in 0..<rows {
                for column in 0..<columns {
                    let depth = values[frame * columns * rows + row * columns + column]
                    guard depth >= frustum.near, depth <= frustum.far else { continue }
                    for corner in [SIMD2(column, row), SIMD2(column + 1, row), SIMD2(column, row + 1), SIMD2(column + 1, row + 1)] {
                        let point = modelFromCamera * SIMD4(
                            (Float(corner.x) / Float(columns) * 2 - 1 - frustum.offset.x) * depth * frustum.tangents.x,
                            (Float(corner.y) / Float(rows) * 2 - 1 - frustum.offset.y) * depth * frustum.tangents.y, depth, 1)
                        let position = SIMD3(point.x, point.y, point.z)
                        lower = simd_min(lower, position); upper = simd_max(upper, position)
                    }
                }
            }
        }
        guard lower.x.isFinite else { return nil }
        return (SCNVector3(lower.x, lower.y, lower.z), SCNVector3(upper.x, upper.y, upper.z))
    }
}

struct TeachingCoverageFrustum {
    let columns: Int, rows: Int
    let near: Float, far: Float
    let tangents: SIMD2<Float>
    let offset: SIMD2<Float>
    // Minimum tolerance, depth-relative tolerance, maximum tolerance.
    let tolerance: SIMD3<Float>

    static let teaching = TeachingCoverageFrustum(columns: TeachingCoverageProfile.columns, rows: TeachingCoverageProfile.rows,
        near: TeachingCoverageProfile.near, far: TeachingCoverageProfile.far,
        tangents: SIMD2(TeachingCoverageProfile.tangentX, TeachingCoverageProfile.tangentY), offset: .zero,
        tolerance: SIMD3(0.018, 0.025, 0.12))

    static func recordedView(_ sample: TeachingSample) throws -> (cameraFromModel: simd_float4x4, frustum: Self) {
        guard let pose = TeachingCoveragePose(sample.cameraPose) else { throw TeachingError("Pose 相机参数无效") }
        let cameraFromModel = pose.cameraFromModel
        guard cameraFromModel.elements.allSatisfy(\.isFinite) else { throw TeachingError("Pose 相机变换无效") }
        // Legacy preview fields describe the iPad screen's lens. All Pose
        // inspection now uses the same M70 optical frame and range as desktop IK.
        let frustum = Self(columns: 160, rows: 100, near: ZividFieldOfView.near, far: ZividFieldOfView.far,
            tangents: SIMD2(ZividFieldOfView.tangentX, ZividFieldOfView.tangentY), offset: .zero,
            tolerance: SIMD3(0.003, 0.002, 0.05))
        return (cameraFromModel, frustum)
    }
}

/// The original model is rasterized on the local GPU once per distinct pose.
/// Display quality does not affect occlusion, and existing depth maps are reused
/// when recording another pose. Nothing is sent to the server or saved in Poses.
actor TeachingCoverageEngine {
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let measurementPipeline: MTLComputePipelineState
    private let depthState: MTLDepthStencilState
    private let modelBuffer: MTLBuffer
    private let vertices: Int, indices: Int
    private let modelBounds: (SIMD3<Float>, SIMD3<Float>)
    private let target: MTLTexture, zBuffer: MTLTexture
    private var cache: [TeachingCoveragePose: [Float]] = [:]
    private var poseFractions: [TeachingCoveragePose: Double] = [:]
    private var measurementPoints: MTLBuffer?
    private var measurementPointCount = 0
    private var measurementPrepared = false
    // Each sample has one bit per category: union within each group, with overlap
    // allowed between groups. Any nonzero mask counts once in the overall union.
    // A new command writes a separate buffer so cancellation cannot corrupt it.
    private var measurementState: (poses: Set<TeachingCoveragePose>, covered: MTLBuffer, measurement: TeachingCoverageMeasurement)?

    init(model: ModelGeometry) throws {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
            throw TeachingError("无法启动已示教区域的本机渲染")
        }
        self.device = device; self.queue = queue; vertices = model.vertices; indices = model.indices
        modelBounds = (SIMD3(Float(model.minimum.x), Float(model.minimum.y), Float(model.minimum.z)),
                       SIMD3(Float(model.maximum.x), Float(model.maximum.y), Float(model.maximum.z)))
        try Task.checkCancellation()
        let library = try device.makeLibrary(source: Self.rasterShader + Self.measurementShader, options: nil)
        guard let measure = library.makeFunction(name: "measureCoverage") else { throw TeachingError("无法创建覆盖率计算") }
        measurementPipeline = try device.makeComputePipelineState(function: measure)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "coverageVertex")
        descriptor.fragmentFunction = library.makeFunction(name: "coverageFragment")
        descriptor.colorAttachments[0].pixelFormat = .r32Float
        descriptor.depthAttachmentPixelFormat = .depth32Float
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less; depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor),
              let modelBuffer = model.data.withUnsafeBytes({ raw in
                  device.makeBuffer(bytes: raw.baseAddress!, length: raw.count, options: .storageModeShared)
              }) else { throw TeachingError("已示教区域渲染内存不足") }
        self.depthState = depthState; self.modelBuffer = modelBuffer
        let texture = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float,
            width: TeachingCoverageProfile.columns, height: TeachingCoverageProfile.rows, mipmapped: false)
        texture.usage = [.renderTarget]; texture.storageMode = .private
        guard let target = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建覆盖深度图") }
        texture.pixelFormat = .depth32Float
        guard let zBuffer = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建遮挡深度图") }
        self.target = target; self.zBuffer = zBuffer
    }

    func build(_ poses: [TeachingCoveragePose], progress: @Sendable (Int) -> Void = { _ in }) async throws -> TeachingCoverageSnapshot {
        let needed = Set(poses)
        cache = cache.filter { needed.contains($0.key) }
        poseFractions = poseFractions.filter { needed.contains($0.key) }
        var matrices: [simd_float4x4] = [], depths: [Float] = []
        var coveredPoses: [TeachingCoveragePose] = []
        var statuses: [TeachingCoveragePose: TeachingCoveragePoseStatus] = [:]
        // Local coverage wins where sources overlap, independent of list order.
        // Measurement retains every category independently of this color priority.
        let ordered = poses.filter { $0.origin == .ipad }
            + poses.filter { $0.arm == .left } + poses.filter { $0.arm == .right }
            + poses.filter { $0.origin == .desktop && $0.arm == nil }
        for (index, pose) in ordered.enumerated() {
            try Task.checkCancellation()
            let grid: [Float]
            if let cached = cache[pose] { grid = cached }
            else {
                // Read the nearest visible surface beyond the working range as
                // well, so a miss can explain distance. Coloring still uses the
                // unchanged M70 near/far limits in the snapshot and shader.
                grid = try await rasterize(cameraFromModel: pose.cameraFromModel, frustum: .teaching,
                                           rasterFar: diagnosticFar(for: pose.cameraFromModel))
                try Task.checkCancellation()
                cache[pose] = grid
            }
            let status = TeachingCoveragePoseStatus(depths: grid)
            statuses[pose] = status
            if status == .covered {
                coveredPoses.append(pose)
                matrices.append(pose.cameraFromModel); depths.append(contentsOf: grid)
            }
            if index % 8 == 0 || index == poses.count - 1 { progress(index + 1) }
        }
        try Task.checkCancellation()
        guard !matrices.isEmpty else {
            measurementState = nil
            return TeachingCoverageSnapshot(frames: nil, depths: nil, frameCount: 0, poseStatuses: statuses, coveredFraction: 0,
                                            categoryFractions: TeachingCoverageMeasurement.zero.categoryFractions)
        }
        guard let frames = matrices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
              let depthData = depths.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }) else {
            throw TeachingError("已示教区域渲染内存不足")
        }
        let measurement = try await measureCoverage(poses: coveredPoses, matrices: matrices, depths: depths)
        return TeachingCoverageSnapshot(frames: frames, depths: depthData, frameCount: matrices.count,
                                        poseStatuses: statuses, coveredFraction: measurement?.fraction,
                                        categoryFractions: measurement?.categoryFractions ?? [:],
                                        ipadFrameCount: coveredPoses.filter { $0.origin == .ipad }.count,
                                        leftArmFrameCount: coveredPoses.filter { $0.arm == .left }.count,
                                        rightArmFrameCount: coveredPoses.filter { $0.arm == .right }.count)
    }

    /// Uniform samples over source triangle AREA, not vertices or triangle count.
    /// Area strata include small faces without giving a densely triangulated part
    /// more weight. The fixed seed keeps progress stable across reopening/quality changes.
    private func prepareMeasurementPoints() throws {
        guard !measurementPrepared else { return }
        let limit = 131_072
        let raw = UnsafeRawBufferPointer(start: modelBuffer.contents(), count: modelBuffer.length)
        func position(_ vertex: Int) throws -> SIMD3<Float> {
            guard vertex >= 0, vertex < vertices else { throw TeachingError("覆盖率计算遇到越界索引") }
            let offset = 32 + vertex * 12
            let p = SIMD3(raw.loadUnaligned(fromByteOffset: offset, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: offset + 4, as: Float.self),
                          raw.loadUnaligned(fromByteOffset: offset + 8, as: Float.self))
            guard (0..<3).allSatisfy({ p[$0].isFinite }) else { throw TeachingError("覆盖率计算遇到无效坐标") }
            return p
        }
        func triangle(_ face: Int) throws -> (SIMD3<Float>, SIMD3<Float>, SIMD3<Float>, Double) {
            let offset = 32 + vertices * 16 + face * 12
            let a = try position(Int(raw.loadUnaligned(fromByteOffset: offset, as: UInt32.self)))
            let b = try position(Int(raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self)))
            let c = try position(Int(raw.loadUnaligned(fromByteOffset: offset + 8, as: UInt32.self)))
            let area = simd_length(simd_cross(SIMD3<Double>(b) - SIMD3<Double>(a),
                                             SIMD3<Double>(c) - SIMD3<Double>(a))) * 0.5
            return (a, b, c, area)
        }
        func random(_ seed: UInt32) -> Float {
            var x = seed
            x ^= x >> 16; x = x &* 0x7feb352d
            x ^= x >> 15; x = x &* 0x846ca68b; x ^= x >> 16
            return Float(x >> 8) / 16_777_216
        }
        var points: [SIMD4<Float>] = []
        points.reserveCapacity(limit)
        if indices > 0 {
            var total = 0.0
            for face in 0..<(indices / 3) {
                if face % 4096 == 0 { try Task.checkCancellation() }
                total += try triangle(face).3
            }
            if total > 0, total.isFinite {
                let step = total / Double(limit)
                var accumulated = 0.0
                for face in 0..<(indices / 3) {
                    if face % 4096 == 0 { try Task.checkCancellation() }
                    let (a, b, c, area) = try triangle(face)
                    accumulated += area
                    while area > 0, points.count < limit, (Double(points.count) + 0.5) * step < accumulated {
                        let seed = UInt32(points.count)
                        let u = sqrt(random(seed &+ 0x9e3779b9)), v = random(seed &+ 0x85ebca6b)
                        points.append(SIMD4(a * (1 - u) + b * (u * (1 - v)) + c * (u * v), 1))
                    }
                }
            }
        } else {
            // A point-only file has no defined surface area. Report the fraction
            // of source points instead, independent of the display density.
            let count = min(vertices, limit)
            for index in 0..<count {
                if index % 4096 == 0 { try Task.checkCancellation() }
                points.append(SIMD4(try position(index * vertices / count), 1))
            }
        }
        try Task.checkCancellation()
        if !points.isEmpty {
            guard let buffer = points.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
            else { throw TeachingError("覆盖率计算内存不足") }
            measurementPoints = buffer
        }
        measurementPointCount = points.count; measurementPrepared = true
    }

    private func measureCoverage(poses: [TeachingCoveragePose], matrices: [simd_float4x4], depths: [Float],
                                 updatesUnion: Bool = true) async throws -> TeachingCoverageMeasurement? {
        try prepareMeasurementPoints()
        guard let points = measurementPoints, measurementPointCount > 0 else { return nil }
        let needed = Set(poses)
        let previous = updatesUnion ? measurementState.flatMap { $0.poses.isSubset(of: needed) ? $0 : nil } : nil
        let additions = poses.indices.filter { previous?.poses.contains(poses[$0]) != true }
        if additions.isEmpty, let previous { return previous.measurement }
        let cellCount = TeachingCoverageProfile.columns * TeachingCoverageProfile.rows
        guard var covered = previous?.covered ?? device.makeBuffer(length: measurementPointCount, options: .storageModeShared)
        else { throw TeachingError("覆盖率计算内存不足") }
        if previous == nil { memset(covered.contents(), 0, measurementPointCount) }
        let frustum = TeachingCoverageFrustum.teaching
        struct Parameters { var counts: SIMD4<UInt32>; var projection: SIMD4<Float>; var tolerance: SIMD4<Float> }
        // Bound individual GPU commands when reopening a project with many Poses,
        // and allow cancellation between batches without publishing partial totals.
        for start in stride(from: 0, to: additions.count, by: 64) {
            try Task.checkCancellation()
            let batch = additions[start..<min(start + 64, additions.count)]
            let nextMatrices = batch.map { matrices[$0] }
            let nextDepths = batch.flatMap { Array(depths[($0 * cellCount)..<(($0 + 1) * cellCount)]) }
            let nextCategories = batch.map { poses[$0].category.coverageMask }
            guard let frames = nextMatrices.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
                  let grids = nextDepths.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
                  let categories = nextCategories.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }),
                  let output = device.makeBuffer(length: measurementPointCount, options: .storageModeShared),
                  let command = queue.makeCommandBuffer(), let encoder = command.makeComputeCommandEncoder()
            else { throw TeachingError("无法准备覆盖率计算") }
            var parameters = Parameters(counts: SIMD4(UInt32(measurementPointCount), UInt32(batch.count), UInt32(frustum.columns), UInt32(frustum.rows)),
                projection: SIMD4(frustum.tangents.x, frustum.tangents.y, frustum.near, frustum.far),
                tolerance: SIMD4(frustum.tolerance, 0))
            encoder.setComputePipelineState(measurementPipeline)
            for (index, buffer) in [points, frames, grids, covered, output].enumerated() { encoder.setBuffer(buffer, offset: 0, index: index) }
            encoder.setBytes(&parameters, length: MemoryLayout<Parameters>.stride, index: 5)
            encoder.setBuffer(categories, offset: 0, index: 6)
            encoder.dispatchThreads(MTLSize(width: measurementPointCount, height: 1, depth: 1),
                threadsPerThreadgroup: MTLSize(width: min(256, measurementPipeline.maxTotalThreadsPerThreadgroup), height: 1, depth: 1))
            encoder.endEncoding()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                command.addCompletedHandler { completed in
                    if completed.status == .completed { continuation.resume() }
                    else { continuation.resume(throwing: TeachingError(completed.error?.localizedDescription ?? "覆盖率计算失败")) }
                }
                command.commit()
            }
            covered = output
        }
        try Task.checkCancellation()
        let flags = UnsafeBufferPointer(start: covered.contents().assumingMemoryBound(to: UInt8.self), count: measurementPointCount)
        var total = 0
        var counts = TeachingPoseCategory.allCases.map { (category: $0, mask: $0.coverageMask, count: 0) }
        for flag in flags where flag != 0 {
            total += 1
            for index in counts.indices where flag & counts[index].mask != 0 { counts[index].count += 1 }
        }
        let denominator = Double(measurementPointCount)
        let measurement = TeachingCoverageMeasurement(fraction: Double(total) / denominator,
            categoryFractions: Dictionary(uniqueKeysWithValues: counts.map { ($0.category, Double($0.count) / denominator) }))
        try Task.checkCancellation()
        if updatesUnion { measurementState = (needed, covered, measurement) }
        return measurement
    }

    /// A selected Pose uses the same full-model samples and M70 visibility as
    /// the aggregate statistics, without changing their incremental union.
    private func measurePose(_ pose: TeachingCoveragePose) async throws -> Double? {
        if let fraction = poseFractions[pose] { return fraction }
        let grid: [Float]
        if let cached = cache[pose] { grid = cached }
        else {
            grid = try await rasterize(cameraFromModel: pose.cameraFromModel, frustum: .teaching,
                                       rasterFar: diagnosticFar(for: pose.cameraFromModel))
            try Task.checkCancellation()
            cache[pose] = grid
        }
        guard TeachingCoveragePoseStatus(depths: grid) == .covered else {
            poseFractions[pose] = 0
            return 0
        }
        let measurement = try await measureCoverage(poses: [pose], matrices: [pose.cameraFromModel],
                                                     depths: grid, updatesUnion: false)
        try Task.checkCancellation()
        poseFractions[pose] = measurement?.fraction
        return measurement?.fraction
    }

    func preview(_ sample: TeachingSample) async throws -> TeachingCoverageSnapshot {
        let (cameraFromModel, frustum) = try TeachingCoverageFrustum.recordedView(sample)
        guard let pose = TeachingCoveragePose(sample.cameraPose, origin: sample.resolvedOrigin, arm: sample.resolvedArm)
        else { throw TeachingError("Pose 相机参数无效") }
        let fraction = try await measurePose(pose)
        let grid = try await rasterize(cameraFromModel: cameraFromModel, frustum: frustum)
        guard grid.contains(where: { $0 >= frustum.near && $0 <= frustum.far }) else {
            return TeachingCoverageSnapshot(frames: nil, depths: nil, frameCount: 0, frustum: frustum,
                                            coveredFraction: fraction)
        }
        var matrix = cameraFromModel
        guard let frames = device.makeBuffer(bytes: &matrix, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared),
              let depths = grid.withUnsafeBytes({ device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) }) else {
            throw TeachingError("Pose 点云预览内存不足")
        }
        return TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1, frustum: frustum,
                                        coveredFraction: fraction,
                                        ipadFrameCount: sample.resolvedOrigin == .ipad ? 1 : 0,
                                        leftArmFrameCount: sample.resolvedArm == .left ? 1 : 0,
                                        rightArmFrameCount: sample.resolvedArm == .right ? 1 : 0)
    }

    func rasterize(_ pose: TeachingCoveragePose) async throws -> [Float] {
        try await rasterize(cameraFromModel: pose.cameraFromModel, frustum: .teaching)
    }

    private func diagnosticFar(for cameraFromModel: simd_float4x4) -> Float {
        var far = TeachingCoverageProfile.far
        for x in [modelBounds.0.x, modelBounds.1.x] {
            for y in [modelBounds.0.y, modelBounds.1.y] {
                for z in [modelBounds.0.z, modelBounds.1.z] {
                    let depth = (cameraFromModel * SIMD4(x, y, z, 1)).z
                    if depth.isFinite { far = max(far, depth + 0.01) }
                }
            }
        }
        return far
    }

    private func rasterize(cameraFromModel: simd_float4x4, frustum: TeachingCoverageFrustum,
                           rasterFar: Float? = nil) async throws -> [Float] {
        try Task.checkCancellation()
        let columns = frustum.columns, rows = frustum.rows
        let colorTarget: MTLTexture, depthTarget: MTLTexture
        if columns == target.width && rows == target.height {
            colorTarget = target; depthTarget = zBuffer
        } else {
            let texture = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float, width: columns, height: rows, mipmapped: false)
            texture.usage = [.renderTarget]; texture.storageMode = .private
            guard let color = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建 Pose 深度图") }
            texture.pixelFormat = .depth32Float
            guard let depth = device.makeTexture(descriptor: texture) else { throw TeachingError("无法创建 Pose 遮挡深度图") }
            colorTarget = color; depthTarget = depth
        }
        // A private readback buffer per command avoids races when a cancelled
        // request is followed by a new one while the GPU is still completing.
        let rowBytes = ((columns * 4 + 255) / 256) * 256
        guard let readback = device.makeBuffer(length: rowBytes * rows, options: .storageModeShared),
              let invalid = device.makeBuffer(length: 4, options: .storageModeShared),
              let command = queue.makeCommandBuffer() else { throw TeachingError("无法准备覆盖区域渲染") }
        invalid.contents().storeBytes(of: UInt32(0), as: UInt32.self)
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = colorTarget
        pass.colorAttachments[0].loadAction = .clear; pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
        pass.depthAttachment.texture = depthTarget
        pass.depthAttachment.loadAction = .clear; pass.depthAttachment.storeAction = .dontCare
        pass.depthAttachment.clearDepth = 1
        guard let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { throw TeachingError("无法绘制覆盖区域") }
        struct Parameters {
            var cameraFromModel: simd_float4x4
            var projection: SIMD4<Float>
            var offset: SIMD4<Float>
            var counts: SIMD4<UInt32>
        }
        var parameters = Parameters(cameraFromModel: cameraFromModel,
            projection: SIMD4(frustum.tangents.x, frustum.tangents.y, TeachingCoverageProfile.rasterNear, rasterFar ?? frustum.far),
            offset: SIMD4(frustum.offset.x, frustum.offset.y, 0, 0),
            counts: SIMD4(UInt32(vertices), 0, 0, 0))
        encoder.setRenderPipelineState(pipeline); encoder.setDepthStencilState(depthState)
        encoder.setCullMode(.none)
        encoder.setVertexBuffer(modelBuffer, offset: 32, index: 0)
        encoder.setVertexBytes(&parameters, length: MemoryLayout<Parameters>.stride, index: 1)
        encoder.setVertexBuffer(invalid, offset: 0, index: 2)
        if indices > 0 {
            encoder.drawIndexedPrimitives(type: .triangle, indexCount: indices, indexType: .uint32,
                indexBuffer: modelBuffer, indexBufferOffset: 32 + vertices * 16)
        } else { encoder.drawPrimitives(type: .point, vertexStart: 0, vertexCount: vertices) }
        encoder.endEncoding()
        guard let blit = command.makeBlitCommandEncoder() else { throw TeachingError("无法读取覆盖深度图") }
        blit.copy(from: colorTarget, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
            sourceSize: MTLSize(width: columns, height: rows, depth: 1), to: readback,
            destinationOffset: 0, destinationBytesPerRow: rowBytes, destinationBytesPerImage: rowBytes * rows)
        blit.endEncoding()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            command.addCompletedHandler { completed in
                if completed.status == .completed { continuation.resume() }
                else { continuation.resume(throwing: TeachingError(completed.error?.localizedDescription ?? "覆盖区域渲染失败")) }
            }
            command.commit()
        }
        try Task.checkCancellation()
        guard invalid.contents().load(as: UInt32.self) == 0 else { throw TeachingError("模型存在无效坐标或越界索引，无法计算覆盖区域") }
        let values = readback.contents().bindMemory(to: Float.self, capacity: rowBytes * rows / 4)
        return (0..<rows).flatMap { row in (0..<columns).map { values[row * rowBytes / 4 + $0] } }
    }

    // Keep the visibility predicate identical to the surface fragment shader:
    // same M70 range, nearest-depth grid and tolerance, followed by per-category unions.
    private static let measurementShader = """

    struct MeasurementParameters { uint4 counts; float4 projection; float4 tolerance; };
    kernel void measureCoverage(device const float4 *points [[buffer(0)]],
        device const float4x4 *frames [[buffer(1)]], device const float *depths [[buffer(2)]],
        device const uchar *previous [[buffer(3)]], device uchar *output [[buffer(4)]],
        constant MeasurementParameters &p [[buffer(5)]], device const uchar *categories [[buffer(6)]],
        uint id [[thread_position_in_grid]]) {
        if (id >= p.counts.x) return;
        uchar covered = previous[id];
        for (uint frame = 0; frame < p.counts.y; ++frame) {
            uchar category = categories[frame];
            if ((covered & category) != 0) continue;
            float3 point = (frames[frame] * points[id]).xyz;
            if (point.z < p.projection.z || point.z > p.projection.w) continue;
            float2 n = point.xy / (point.z * p.projection.xy);
            if (any(abs(n) > 1.0)) continue;
            float2 size = float2(p.counts.zw);
            int2 cell = clamp(int2((n + 1.0) * 0.5 * size), int2(0), int2(size) - 1);
            float depth = depths[frame * p.counts.z * p.counts.w + cell.y * p.counts.z + cell.x];
            if (depth < p.projection.z) continue;
            float tolerance = min(p.tolerance.z, max(p.tolerance.x, max(depth * p.tolerance.y,
                length(2.0 * p.projection.xy * depth / size) * 0.72)));
            if (point.z <= depth + tolerance) covered |= category;
        }
        output[id] = covered;
    }
    """

    private static let rasterShader = """
    #include <metal_stdlib>
    using namespace metal;
    struct Parameters { float4x4 cameraFromModel; float4 projection; float4 offset; uint4 counts; };
    struct RasterVertex { float4 position [[position]]; float cameraDepth; float pointSize [[point_size]]; };
    vertex RasterVertex coverageVertex(uint vertexID [[vertex_id]],
        device const packed_float3 *positions [[buffer(0)]], constant Parameters &p [[buffer(1)]],
        device atomic_uint *invalid [[buffer(2)]]) {
        RasterVertex result; result.pointSize = 1.0; result.cameraDepth = 0.0;
        result.position = float4(2.0, 2.0, 2.0, 1.0);
        if (vertexID >= p.counts.x) { atomic_store_explicit(invalid, 1u, memory_order_relaxed); return result; }
        float3 point = float3(positions[vertexID]);
        if (!all(isfinite(point))) { atomic_store_explicit(invalid, 1u, memory_order_relaxed); return result; }
        float3 camera = (p.cameraFromModel * float4(point, 1.0)).xyz;
        float near = p.projection.z, far = p.projection.w;
        result.position = float4(camera.x / p.projection.x + p.offset.x * camera.z,
            -camera.y / p.projection.y - p.offset.y * camera.z,
            (camera.z - near) * far / (far - near), camera.z);
        result.cameraDepth = camera.z;
        return result;
    }
    fragment float coverageFragment(RasterVertex in [[stage_in]]) { return in.cameraDepth; }
    """
}

@MainActor
final class TeachingCoverageRenderer: ObservableObject {
    @Published var enabled = true { didSet { apply() } }
    @Published var opacity: Float = 0.25 { didSet { apply() } }
    @Published private(set) var preparing = false
    @Published private(set) var processed = 0
    @Published private(set) var poseCount = 0
    @Published private(set) var hitCount = 0
    @Published private(set) var coveredFraction: Double? = 0
    @Published private(set) var categoryFractions = TeachingCoverageMeasurement.zero.categoryFractions
    @Published private(set) var latestPoseStatus: TeachingCoveragePoseStatus?
    @Published private(set) var error = ""
    private var model: ModelGeometry?
    private var poses: [TeachingCoveragePose] = []
    private var appliedPoses: [TeachingCoveragePose] = []
    private var engine: Task<TeachingCoverageEngine, Error>?
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var snapshot: TeachingCoverageSnapshot?
    private var latestPose: TeachingCoveragePose?
    private var latestPoseName = "最近的 Pose"
    private weak var rendered: SCNGeometry?

    var coverageTitle: String { model?.indices == 0 ? "点云覆盖率" : "表面覆盖率" }
    var coveragePercentage: String { Self.percentage(coveredFraction) }
    var categoryPercentages: [TeachingPoseCategory: String] {
        Dictionary(uniqueKeysWithValues: TeachingPoseCategory.allCases.map { ($0, Self.percentage(categoryFractions[$0])) })
    }
    static func percentage(_ value: Double?) -> String {
        guard let fraction = value else { return "—" }
        if fraction == 0 { return "0%" }
        if fraction < 0.001 { return "<0.1%" }
        if fraction == 1 { return "100%" }
        if fraction > 0.999 { return ">99.9%" }
        return String(format: "%.1f%%", fraction * 100)
    }
    var status: String {
        if !error.isEmpty { return error }
        if !enabled { return "已隐藏" }
        if poseCount == 0 { return "记录 Pose 后显示覆盖区域" }
        if preparing { return "正在本机计算 \(processed) / \(poses.count) 个视角…" }
        switch latestPoseStatus {
        case .covered: return "\(latestPoseName) · 已在模型表面着色"
        case .tooNear(let depth):
            return "\(latestPoseName) 距可见表面约 \(String(format: "%.2f", depth)) m，低于 M70 的 0.3 m 下限，请后退再记录。"
        case .tooFar(let depth):
            return "\(latestPoseName) 距可见表面约 \(String(format: "%.2f", depth)) m，超过 M70 的 1.3 m 上限，请靠近再记录。"
        case .outsideView: return "\(latestPoseName) 的视野未命中模型，请让物体进入 M70 取景框后再记录。"
        case nil: return "最近的 Pose 相机参数无效，无法显示覆盖区域。"
        }
    }
    var hasCoverageWarning: Bool { !preparing && poseCount > 0 && latestPoseStatus != .covered }

    func update(model: ModelGeometry, samples: [TeachingSample]) {
        self.model = model
        latestPose = samples.last.flatMap { TeachingCoveragePose($0.cameraPose, origin: $0.resolvedOrigin, arm: $0.resolvedArm) }
        latestPoseName = samples.last.map { $0.name.isEmpty ? "最近的 Pose" : $0.name } ?? "最近的 Pose"
        var seen = Set<TeachingCoveragePose>()
        let next = samples.compactMap { TeachingCoveragePose($0.cameraPose, origin: $0.resolvedOrigin, arm: $0.resolvedArm) }.filter { seen.insert($0).inserted }
        poseCount = samples.count
        latestPoseStatus = latestPose.flatMap { snapshot?.poseStatuses[$0] }
        guard next != poses else { return }
        let removed = !Set(poses).isSubset(of: seen)
        poses = next
        // Retain the previous union while adding a pose. Removed or edited
        // cameras must disappear immediately, including during rebuild.
        if removed {
            snapshot = nil; hitCount = 0; coveredFraction = next.isEmpty ? 0 : nil
            categoryFractions = next.isEmpty ? TeachingCoverageMeasurement.zero.categoryFractions : [:]
            apply()
        }
        rebuild()
    }

    func attach(to geometry: SCNGeometry?) { rendered = geometry; apply() }
    func cancel() { generation = UUID(); task?.cancel(); preparing = false }
    func resume() { if snapshot == nil || appliedPoses != poses { rebuild() } }

    /// Inspection shares the original model's GPU buffer, but uses the recorded
    /// camera frustum instead of the live M70 coverage range or union.
    func previewSnapshot(for sample: TeachingSample) async throws -> TeachingCoverageSnapshot {
        guard let model else {
            throw TeachingError("无法读取此 Pose 的点云范围")
        }
        if engine == nil { engine = Task.detached(priority: .utility) { try TeachingCoverageEngine(model: model) } }
        let service = try await engine!.value
        try Task.checkCancellation()
        return try await service.preview(sample)
    }

    private func rebuild() {
        cancel(); error = ""; processed = 0
        guard !poses.isEmpty, let model else {
            coveredFraction = 0; categoryFractions = TeachingCoverageMeasurement.zero.categoryFractions
            return
        }
        if engine == nil { engine = Task.detached(priority: .utility) { try TeachingCoverageEngine(model: model) } }
        let engine = engine!, inputs = poses, request = generation
        preparing = true
        task = Task {
            do {
                let service = try await engine.value
                try Task.checkCancellation()
                let result = try await service.build(inputs) { [weak self] count in
                    Task { @MainActor in
                        guard let self, self.generation == request else { return }
                        self.processed = count
                    }
                }
                guard !Task.isCancelled, generation == request else { return }
                snapshot = result; appliedPoses = inputs
                coveredFraction = result.coveredFraction
                categoryFractions = result.categoryFractions
                latestPoseStatus = latestPose.flatMap { result.poseStatuses[$0] }
                hitCount = result.frameCount; preparing = false; apply()
            } catch {
                guard !Task.isCancelled, generation == request else { return }
                self.error = "覆盖显示失败：\(error.localizedDescription)"; preparing = false
                self.engine = nil
            }
        }
    }

    private func apply() {
        for material in rendered?.materials ?? [] {
            guard enabled, let snapshot, snapshot.frameCount > 0 else {
                material.shaderModifiers = nil
                material.setValue(nil, forKey: "atlasCoverageFrames")
                material.setValue(nil, forKey: "atlasCoverageDepths")
                continue
            }
            Self.apply(snapshot, opacity: opacity, to: material)
        }
    }

    static func apply(_ snapshot: TeachingCoverageSnapshot, opacity: Float, to material: SCNMaterial,
                      clipOutside: Bool = false) {
        material.setValue(snapshot.frames, forKey: "atlasCoverageFrames")
        material.setValue(snapshot.depths, forKey: "atlasCoverageDepths")
        material.setValue(snapshot.frameCount, forKey: "atlasCoverageCount")
        material.setValue(snapshot.ipadFrameCount, forKey: "atlasCoverageIPadCount")
        material.setValue(snapshot.leftArmFrameCount, forKey: "atlasCoverageLeftArmCount")
        material.setValue(snapshot.rightArmFrameCount, forKey: "atlasCoverageRightArmCount")
        // Metal output is linear, as are Three.js colors on the desktop.
        for (category, key) in [(TeachingPoseCategory.ipad, "atlasCoverageIPadColor"),
                                (.leftArm, "atlasCoverageLeftArmColor"), (.rightArm, "atlasCoverageRightArmColor"),
                                (.desktop, "atlasCoverageDesktopColor")] {
            let rgb = category.linearRGB
            material.setValue(SCNVector3(rgb.x, rgb.y, rgb.z), forKey: key)
        }
        material.setValue(opacity, forKey: "atlasCoverageOpacity")
        material.setValue(clipOutside ? 1 : 0, forKey: "atlasCoverageClipOutside")
        let frustum = snapshot.frustum
        material.setValue(SCNVector4(frustum.tangents.x, frustum.tangents.y, frustum.offset.x, frustum.offset.y), forKey: "atlasCoverageProjection")
        material.setValue(SCNVector4(frustum.near, frustum.far, Float(frustum.columns), Float(frustum.rows)), forKey: "atlasCoverageLimits")
        material.setValue(SCNVector3(frustum.tolerance.x, frustum.tolerance.y, frustum.tolerance.z), forKey: "atlasCoverageTolerance")
        material.shaderModifiers = [.geometry: """
            #pragma varyings
            float3 atlasCoveragePosition;
            #pragma body
            out.atlasCoveragePosition = _geometry.position.xyz;
            """, .fragment: """
            #pragma arguments
            float4x4* atlasCoverageFrames;
            float* atlasCoverageDepths;
            int atlasCoverageCount;
            int atlasCoverageIPadCount;
            int atlasCoverageLeftArmCount;
            int atlasCoverageRightArmCount;
            float3 atlasCoverageIPadColor;
            float3 atlasCoverageLeftArmColor;
            float3 atlasCoverageRightArmColor;
            float3 atlasCoverageDesktopColor;
            float atlasCoverageOpacity;
            int atlasCoverageClipOutside;
            float4 atlasCoverageProjection;
            float4 atlasCoverageLimits;
            float3 atlasCoverageTolerance;
            #pragma body
            bool atlasCovered = false;
            for (int frame = 0; frame < atlasCoverageCount; ++frame) {
                float3 p = (atlasCoverageFrames[frame] * float4(in.atlasCoveragePosition, 1.0)).xyz;
                if (p.z < atlasCoverageLimits.x || p.z > atlasCoverageLimits.y) continue;
                float2 tangents = atlasCoverageProjection.xy;
                float2 n = p.xy / (p.z * tangents) + atlasCoverageProjection.zw;
                if (any(abs(n) > 1.0)) continue;
                float2 size = atlasCoverageLimits.zw;
                int2 cell = clamp(int2((n + 1.0) * 0.5 * size), int2(0), int2(size) - 1);
                float depth = atlasCoverageDepths[frame * int(size.x * size.y) + cell.y * int(size.x) + cell.x];
                if (depth < atlasCoverageLimits.x) continue;
                float tolerance = min(atlasCoverageTolerance.z, max(atlasCoverageTolerance.x, max(depth * atlasCoverageTolerance.y,
                    length(2.0 * tangents * depth / size) * 0.72)));
                if (p.z <= depth + tolerance) {
                    atlasCovered = true;
                    float3 tint = frame < atlasCoverageIPadCount ? atlasCoverageIPadColor
                        : frame < atlasCoverageIPadCount + atlasCoverageLeftArmCount ? atlasCoverageLeftArmColor
                        : frame < atlasCoverageIPadCount + atlasCoverageLeftArmCount + atlasCoverageRightArmCount ? atlasCoverageRightArmColor
                        : atlasCoverageDesktopColor;
                    _output.color.rgb = mix(float3(_output.color.rgb), tint, atlasCoverageOpacity);
                    break;
                }
            }
            if (atlasCoverageClipOutside != 0 && !atlasCovered) discard_fragment();
            """]
    }
}
