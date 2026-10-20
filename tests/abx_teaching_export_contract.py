"""Run exact copies of ABX readers in a disposable directory, with no external writes."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
from unittest.mock import patch


sys.dont_write_bytecode = True
folder, brain = (Path(value).resolve() for value in sys.argv[1:])
assert folder != brain and brain not in folder.parents


def temporary_path(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        destination = Path(os.fsdecode(value)).resolve()
        if destination != folder and folder not in destination.parents:
            raise PermissionError(f'Contract test cannot write outside its temporary directory: {destination}')


def isolated_io(event, args):
    if event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        temporary_path(args[0])
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'sqlite3.connect'):
        temporary_path(args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        temporary_path(args[0]); temporary_path(args[1])
    elif event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise PermissionError(f'Contract test cannot contact or start external services: {event}')


sys.addaudithook(isolated_io)
snapshot = folder / 'brain-source-snapshot'
source_digests = {}
for part in ('web', 'chassis', 'platform', 'logging', 'storage'):
    for source in (brain / 'tools' / part).glob('*.py'):
        data = source.read_bytes()
        source_digests[source] = hashlib.sha256(data).digest()
        destination = snapshot / 'tools' / part / source.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
os.chdir(folder)
sys.path[:0] = [str(snapshot / 'tools/web'), str(snapshot / 'tools/chassis')]
import teaching_store as teaching
import route_graph
import execution_plan
from route_library import RouteLibrary, graph, validate as validate_route


database = folder / 'isolated-pipeline' / 'teaching' / 'fixture.sqlite3'
os.environ['ABX_PIPELINE_ROOT'] = str(database.parent.parent)
os.environ['ABX_RUNTIME_BACKEND'] = 'mock'


def call(operation, expected=200, **args):
    output = io.StringIO()
    teaching.run(str(database), {'op': operation, 'args': args}, output)
    status, body = output.getvalue().split('\n', 1)
    assert int(status) == expected, (operation, status, body)
    return json.loads(body)


def import_task(lines, identity, expected=200):
    call('import/begin', request_id=identity, header=lines[0])
    # Exercise the same bounded UTF-8/base64 transport used by the native Web UI.
    for line in lines[1:-1]:
        chunk = base64.b64encode((line + '\n').encode('utf-8')).decode('ascii')
        call('import/append', task_id=identity, lines=chunk)
    return call('import/finish', expected=expected, task_id=identity, footer=lines[-1])


call('init')
manifest = json.loads((folder / 'abx/manifest.json').read_text())
navigation = json.loads((folder / 'abx/navigation.json').read_text())
assert navigation['mode'] == 'route' and navigation['nativeTaskNavigationSupported'] is True
assert teaching.VERSION == 23, 'Review the supplied Brain contract before changing export assumptions'
assert validate_route(navigation['route']) == navigation['route']
# Existing business route and active selection must survive native imports.
library = RouteLibrary()
existing = dict(navigation['route'], id='existing-business-route', name='已有业务路网', scene_name='现场业务地图')
library.save(existing, '')
library.mark(existing, 'ready', 'existing business selection', '0' * 32, library.context())
existing_files = {path: path.read_bytes() for path in library.root.glob('*.json')}


def context_of(lines):
    chunks = [base64.b64decode(value['data']) for line in lines
              if (value := json.loads(line))['type'] == 'navigation_chunk']
    return json.loads(b''.join(chunks)) if chunks else None


def body_of(lines):
    return [value for line in lines[1:-1] if (value := json.loads(line))['type'] != 'navigation_chunk']


for index, item in enumerate(manifest['tasks']):
    lines = (folder / 'abx' / item['file']).read_text().rstrip('\n').split('\n')
    result = import_task(lines, item['id'])
    assert result['task']['name'] == item['name']
    assert result['task']['point_count'] == item['point_count']
    output = io.StringIO()
    teaching.run(str(database), {'op': 'export', 'args': {'task_id': item['id']}}, output)
    status, exported = output.getvalue().split('\n', 1)
    assert status == '200'
    exported = exported.rstrip('\n').split('\n')
    source_context, restored_context = context_of(lines), context_of(exported)
    expected_body = body_of(lines)
    if source_context:
        restored_route = restored_context['routes'][0]
        assert restored_route['id'].startswith('import-')
        assert restored_route == dict(source_context['routes'][0], id=restored_route['id'])
        assert library.get(restored_route['id'])['document'] == restored_route
        for point in expected_body:
            if teaching.is_navigation(point.get('record')):
                point['record']['route_id'] = restored_route['id']
        for copy in item['navigation']['routes']:
            assert json.loads((folder / 'abx' / copy).read_text()) == source_context['routes'][0]
    else:
        assert restored_context is None
    assert body_of(exported) == expected_body, 'native import must retain every Pose, parking and navigation step'
    checksum = hashlib.sha256(('\n'.join(exported[1:-1]) + ('\n' if len(exported) > 2 else '')).encode()).hexdigest()
    assert json.loads(exported[-1])['sha256'] == checksum
    # Re-exported files must also import without loss into another task.
    import_task(exported, f'{index + 100:032x}')
    if index == 0:
        plan = execution_plan.load_plan(str(database), [item['id']], 'mock', 'botx_abx_zivid_m70')
        assert plan['summary']['navigation_count'] == 2
        assert plan['summary']['capture_count'] == 0
        assert plan['summary']['point_count'] == 5
        parkings = plan['tasks'][0]['parkings']
        assert [group['name'] for group in parkings] == ['停车点 A', '停车点 B']
        points = [point for group in parkings for point in group['points']]
        assert [point['kind'] for point in points] == ['navigation', 'pose', 'pose', 'navigation', 'pose']
        poses = [point for point in points if point['kind'] == 'pose']
        assert all(point['component'] == 'auto' and len(point['joints']) == 20 for point in poses)
        for point, step in zip((point for point in points if point['kind'] == 'navigation'),
                               (step for step in navigation['tasks'][0]['sequence'] if step['type'] == 'route_navigation')):
            assert point['node_name'] == step['nodeId']
            assert math.hypot(*(point['target'][key] - step['target'][key] for key in ('x_m', 'y_m'))) <= 1e-6
            yaw_delta = point['target']['yaw_rad'] - step['target']['yaw_rad']
            assert abs(math.atan2(math.sin(yaw_delta), math.cos(yaw_delta))) <= 1e-6
            assert point['route_id'] == restored_route['id']
        assert plan['tasks'][0]['map_names'] == [], 'export must not invent a localization map identity'
        # A route activated/bound by the operator supplies the real scene name.
        bound = dict(restored_route, scene_name='机器人现场地图')
        with patch.object(route_graph, 'load_graph', return_value=graph(bound)):
            bound_plan = execution_plan.load_plan(str(database), [item['id']], 'mock', 'botx_abx_zivid_m70')
        assert bound_plan['tasks'][0]['map_names'] == ['机器人现场地图']
        # A changed body with the old footer must never become visible.
        tampered = list(lines)
        record_index = next(i for i, line in enumerate(lines) if 'joints_rad' in json.loads(line).get('record', {}))
        changed = json.loads(tampered[record_index])
        changed['record']['joints_rad']['head'][0] += 0.1
        tampered[record_index] = json.dumps(changed, ensure_ascii=False, separators=(',', ':'))
        rejected = 'f' * 32
        import_task(tampered, rejected, expected=400)
        call('task', expected=404, task_id=rejected)
        call('task', task_id=item['id'])
        # Chunks, as well as joint records, are covered by the native checksum.
        tampered = list(lines)
        chunk_index = next(i for i, line in enumerate(lines) if json.loads(line)['type'] == 'navigation_chunk')
        chunk = json.loads(tampered[chunk_index])
        chunk['data'] = base64.b64encode(b'corrupt route data').decode()
        tampered[chunk_index] = json.dumps(chunk, separators=(',', ':'))
        import_task(tampered, 'e' * 32, expected=400)
        call('task', expected=404, task_id='e' * 32)
        assert len(list(library.root.glob('*.route.json'))) == 2, 'repeat imports reuse the route; damaged imports publish none'

stress_manifest = json.loads((folder / 'stress/abx/manifest.json').read_text())
stress_navigation = json.loads((folder / 'stress/abx/navigation.json').read_text())
stress_route_ids = set()
for index, item in enumerate(stress_manifest['tasks']):
    lines = (folder / 'stress/abx' / item['file']).read_text().rstrip('\n').split('\n')
    identity = f'{index + 200:032x}'
    import_task(lines, identity)
    if item['navigation'] is None:
        continue
    assert int(json.loads(lines[0])['navigation']['chunks']) > 1
    output = io.StringIO()
    teaching.run(str(database), {'op': 'export', 'args': {'task_id': identity}}, output)
    exported = output.getvalue().splitlines()[1:]
    context = context_of(exported)
    route = context['routes'][0]
    assert route == dict(stress_navigation['route'], id=route['id'])
    validate_route(route)
    stress_route_ids.add(route['id'])
    plan = execution_plan.load_plan(str(database), [identity], 'mock', 'botx_abx_zivid_m70')
    assert plan['summary']['point_count'] == int(item['point_count'])
    original_poses = [value for value in body_of(lines) if 'joints_rad' in value.get('record', {})]
    assert [value for value in body_of(exported) if 'joints_rad' in value.get('record', {})] == original_poses
    expected = stress_navigation['tasks'][index]['sequence']
    planned = [point for parking in plan['tasks'][0]['parkings'] for point in parking['points']]
    assert [point['kind'] for point in planned] == ['navigation' if step['type'] == 'route_navigation' else 'pose' for step in expected]
assert len(stress_route_ids) == 1, 'multi-task imports must reuse the complete shared route'

assert all(hashlib.sha256(source.read_bytes()).digest() == digest for source, digest in source_digests.items())
assert all(path.read_bytes() == data for path, data in existing_files.items()), 'existing routes and active selection changed'
print('Native ABX v23 import, route recovery, checksum rejection, re-export and navigation/Pose execution-plan verification passed (isolated copies; source tree unchanged)')
