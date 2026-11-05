"""Bake the CC0 standing person into one lightweight, Z-up, +X-facing mesh.

Run with Blender in background mode; see the asset README for the source URL:
  blender -b --python scripts/prepare_pedestrian_model.py -- source.glb output.ply
"""
import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('source', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--triangles', type=int, default=12000)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
expected_sha256 = '19f5096f559fd09066435a96250f61b24338ac011c9ae185ef83e9d5256d7225'
if hashlib.sha256(args.source.read_bytes()).hexdigest() != expected_sha256:
    raise ValueError('Unexpected source asset; verify its origin and license before replacing the pinned model.')
if not 4000 <= args.triangles <= 20000:
    raise ValueError('Use a triangle budget between 4000 and 20000.')

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(args.source.resolve()))
objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
total = 0
for obj in objects:
    obj.data.calc_loop_triangles()
    total += len(obj.data.loop_triangles)
ratio = min(1, args.triangles / total)
vertices, normals, faces = [], [], []
# Blender imports glTF with Z up and this person's face pointing toward -Y.
facing = Matrix.Rotation(math.pi / 2, 4, 'Z')
for obj in objects:
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.00001)
    bpy.ops.object.mode_set(mode='OBJECT')
    modifier = obj.modifiers.new('Display mesh simplification', 'DECIMATE')
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.update()
    obj.data.calc_loop_triangles()
    transform = facing @ obj.matrix_world
    normal_transform = transform.to_3x3().inverted().transposed()
    offset = len(vertices)
    vertices.extend(transform @ vertex.co for vertex in obj.data.vertices)
    normals.extend((normal_transform @ vertex.normal).normalized() for vertex in obj.data.vertices)
    faces.extend(tuple(offset + index for index in triangle.vertices) for triangle in obj.data.loop_triangles)

minimum = Vector(tuple(min(vertex[i] for vertex in vertices) for i in range(3)))
maximum = Vector(tuple(max(vertex[i] for vertex in vertices) for i in range(3)))
height = maximum.z - minimum.z
origin = Vector(((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, minimum.z))
vertices = [(vertex - origin) / height for vertex in vertices]
args.output.parent.mkdir(parents=True, exist_ok=True)
header = '\n'.join([
    'ply', 'format binary_little_endian 1.0',
    'comment Innerscene standing person, adapted from MakeHuman CC0 assets; CC0-1.0',
    'comment Normalized height 1; feet at Z=0; front +X; original proportions retained',
    f'element vertex {len(vertices)}',
    *[f'property float {key}' for key in ['x', 'y', 'z', 'nx', 'ny', 'nz']],
    f'element face {len(faces)}', 'property list uchar uint vertex_indices', 'end_header', '',
]).encode('ascii')
with args.output.open('wb') as output:
    output.write(header)
    for vertex, normal in zip(vertices, normals):
        output.write(struct.pack('<6f', *vertex, *normal))
    for face in faces:
        output.write(struct.pack('<B3I', 3, *face))
print(json.dumps({'output': str(args.output), 'vertices': len(vertices), 'triangles': len(faces),
    'bytes': args.output.stat().st_size, 'source_height_m': height,
    'normalized_dimensions': list((maximum - minimum) / height)}, indent=2))
