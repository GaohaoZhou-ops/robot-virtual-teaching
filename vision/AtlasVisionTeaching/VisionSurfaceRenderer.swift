import RealityKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Point clouds remain unlit; map/workpiece meshes use the Web surface shader.
/// Robot surfaces retain their source PBR materials and project-space light rig.
@MainActor
enum VisionSurfaceRenderer {
    private static var environment: EnvironmentResource?
    private static var mapMaterial: ShaderGraphMaterial?
    static let mapViewLight = simd_normalize(SIMD3<Float>(0.32, 0.46, 0.83))

    static func makeEntity(_ data: VisionMeshData, surface: VisionSceneMaterial? = nil, mapSurface: Bool = false) async throws -> ModelEntity {
        var descriptor = MeshDescriptor(name: "Atlas surface")
        descriptor.positions = MeshBuffers.Positions(data.positions)
        if !data.normals.isEmpty { descriptor.normals = MeshBuffers.Normals(data.normals) }
        descriptor.textureCoordinates = MeshBuffers.TextureCoordinates(data.textureCoordinates)
        descriptor.primitives = .triangles(data.triangles)
        let mesh = try await MeshResource(from: [descriptor])
        try Task.checkCancellation()
        guard let provider = CGDataProvider(data: Data(data.pixels) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let image = CGImage(width: data.textureSide, height: data.textureSide, bitsPerComponent: 8,
                bitsPerPixel: 32, bytesPerRow: data.textureSide * 4, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw TeachingError("模型颜色纹理生成失败") }
        let texture = try await TextureResource(image: image, options: .init(semantic: .color, mipmapsMode: .none))
        let entity: ModelEntity
        if let surface, data.isMesh {
            var material = PhysicallyBasedMaterial()
            material.baseColor = .init(tint: .white, texture: .init(texture))
            material.roughness = .init(floatLiteral: surface.roughness)
            material.metallic = .init(floatLiteral: surface.metallic)
            material.faceCulling = .none
            entity = ModelEntity(mesh: mesh, materials: [material])
        } else if mapSurface && data.isMesh {
            if mapMaterial == nil {
                mapMaterial = try await ShaderGraphMaterial(named: "/Root/AtlasMapSurface", from: Data(mapShader.utf8))
            }
            var material = mapMaterial!
            try material.setParameter(name: "ColorTexture", value: .textureResource(texture))
            try material.setParameter(name: "LightDirection", value: .simd3Float(mapViewLight))
            material.faceCulling = .none
            entity = ModelEntity(mesh: mesh, materials: [material])
        } else {
            var material = UnlitMaterial()
            material.color = .init(tint: .white, texture: .init(texture))
            material.faceCulling = .none
            entity = ModelEntity(mesh: mesh, materials: [material])
        }
        // Dense map splats must not enter the robot's shadow map.
        entity.components.set(DynamicLightShadowComponent(castsShadow: surface != nil && data.isMesh))
        return entity
    }

    static func updateMapLight(_ entity: ModelEntity, direction: SIMD3<Float>) {
        guard var model = entity.model, var material = model.materials.first as? ShaderGraphMaterial else { return }
        // The parameter is validated when the material is created. Changing
        // only this uniform preserves geometry and color textures while walking.
        try? material.setParameter(name: "LightDirection", value: .simd3Float(direction))
        model.materials = [material]; entity.model = model
    }

    // Matches PointCloudViewer's flat, two-sided mesh shading exactly:
    // linear RGB * (0.68 + 0.32 * abs(dot(viewNormal, viewLight))).
    // The light is rotated into world space by the headset pose; normals are
    // transformed by RealityKit, so sandbox scaling/rotation also stays correct.
    // Keep RealityKit's normal textured-color output path. Bypassing its post
    // process also bypasses exposure compensation and washes out source RGB.
    private static let mapShader = """
    #usda 1.0
    (defaultPrim = "Root")
    def Xform "Root" {
        def Material "AtlasMapSurface" {
            asset inputs:ColorTexture
            float3 inputs:LightDirection = (0.32, 0.46, 0.83)
            token outputs:mtlx:surface.connect = </Root/AtlasMapSurface/Surface.outputs:out>
            def Shader "Texture" {
                uniform token info:id = "ND_image_color3"
                asset inputs:file.connect = </Root/AtlasMapSurface.inputs:ColorTexture>
                string inputs:filtertype = "closest"
                color3f outputs:out
            }
            def Shader "Normal" {
                uniform token info:id = "ND_normal_vector3"
                string inputs:space = "world"
                float3 outputs:out
            }
            def Shader "Dot" {
                uniform token info:id = "ND_dotproduct_vector3"
                float3 inputs:in1.connect = </Root/AtlasMapSurface/Normal.outputs:out>
                float3 inputs:in2.connect = </Root/AtlasMapSurface.inputs:LightDirection>
                float outputs:out
            }
            def Shader "Absolute" {
                uniform token info:id = "ND_absval_float"
                float inputs:in.connect = </Root/AtlasMapSurface/Dot.outputs:out>
                float outputs:out
            }
            def Shader "Directional" {
                uniform token info:id = "ND_multiply_float"
                float inputs:in1.connect = </Root/AtlasMapSurface/Absolute.outputs:out>
                float inputs:in2 = 0.32
                float outputs:out
            }
            def Shader "Light" {
                uniform token info:id = "ND_add_float"
                float inputs:in1.connect = </Root/AtlasMapSurface/Directional.outputs:out>
                float inputs:in2 = 0.68
                float outputs:out
            }
            def Shader "ShadedColor" {
                uniform token info:id = "ND_multiply_color3FA"
                color3f inputs:in1.connect = </Root/AtlasMapSurface/Texture.outputs:out>
                float inputs:in2.connect = </Root/AtlasMapSurface/Light.outputs:out>
                color3f outputs:out
            }
            def Shader "Surface" {
                uniform token info:id = "ND_realitykit_unlit_surfaceshader"
                color3f inputs:color.connect = </Root/AtlasMapSurface/ShadedColor.outputs:out>
                bool inputs:applyPostProcessToneMap = 1
                token outputs:out
            }
        }
    }
    """

    static func configureLighting(_ lighting: Entity) async throws {
        guard lighting.components[ImageBasedLightComponent.self] == nil else { return }
        if environment == nil { environment = try await EnvironmentResource(equirectangular: ambientImage()) }
        try Task.checkCancellation()
        var ambient = ImageBasedLightComponent(source: .single(environment!))
        ambient.inheritsRotation = true
        lighting.components.set(ambient)
        let key = Entity()
        key.name = "Robot key light"
        key.components.set(DirectionalLightComponent(color: .white, intensity: 1200))
        key.components.set(DirectionalLightComponent.Shadow(shadowProjection: .automatic(maximumDistance: 12), depthBias: 1))
        lighting.addChild(key)
        key.look(at: .zero, from: SIMD3(-4, -6, 9), relativeTo: lighting)
        let fill = Entity()
        fill.name = "Robot fill light"
        fill.components.set(DirectionalLightComponent(color: .init(red: 0.46, green: 0.86, blue: 0.91, alpha: 1), intensity: 350))
        lighting.addChild(fill)
        fill.look(at: .zero, from: SIMD3(5, 3, 2), relativeTo: lighting)
    }

    private static func ambientImage() throws -> CGImage {
        // Small linear HDR hemisphere: cool overhead fill and a darker floor.
        // Generating it locally keeps offline projects independent of assets
        // and the brightness of the user's physical room.
        let width = 128, height = 64
        let sky = SIMD3<Float>(0.28, 0.34, 0.36), ground = SIMD3<Float>(0.035, 0.045, 0.055)
        var pixels = [Float](repeating: 1, count: width * height * 4)
        for y in 0..<height {
            let latitude = Float.pi * (0.5 - (Float(y) + 0.5) / Float(height))
            for x in 0..<width {
                let longitude = 2 * Float.pi * ((Float(x) + 0.5) / Float(width) - 0.5)
                let z = cos(latitude) * cos(longitude)
                let color = simd_mix(ground, sky, SIMD3(repeating: (z + 1) / 2))
                let offset = (y * width + x) * 4
                for channel in 0..<3 { pixels[offset + channel] = color[channel] }
            }
        }
        let bytes = pixels.withUnsafeBytes { Data($0) }
        guard let provider = CGDataProvider(data: bytes as CFData), let space = CGColorSpace(name: CGColorSpace.extendedLinearSRGB),
              let image = CGImage(width: width, height: height, bitsPerComponent: 32, bitsPerPixel: 128,
                bytesPerRow: width * 16, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue).union(.floatComponents).union(.byteOrder32Little),
                provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else {
            throw TeachingError("机器人环境光生成失败")
        }
        return image
    }
}
