"""Exercise the supplied, unmodified Brain importer against complete Atlas ZIPs."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import zipfile

sys.dont_write_bytecode = True
folder, brain = (Path(value).resolve() for value in sys.argv[1:])


def temporary_path(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        target = Path(os.fsdecode(value)).resolve()
        if target != folder and folder not in target.parents:
            raise PermissionError(f'Test cannot write outside temporary directory: {target}')


def isolated_io(event, args):
    if event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        temporary_path(args[0])
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'sqlite3.connect'):
        temporary_path(args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        temporary_path(args[0]); temporary_path(args[1])
    elif event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise PermissionError(f'Test cannot contact robot services: {event}')


sys.addaudithook(isolated_io)
os.chdir(folder)
sys.path[:0] = [str(brain / 'tools/web'), str(brain / 'tools/chassis')]
import teaching_store as teaching
import teaching_navigation
import execution_plan
from route_library import RouteLibrary

database = folder / 'pipeline/teaching/test.sqlite3'
os.environ['ABX_PIPELINE_ROOT'] = str(database.parent.parent)
os.environ['ABX_RUNTIME_BACKEND'] = 'mock'


def call(operation, expected=200, **args):
    output = io.StringIO()
    teaching.run(str(database), {'op': operation, 'args': args}, output)
    status, body = output.getvalue().split('\n', 1)
    assert int(status) == expected, (operation, status, body)
    return body if operation == 'export' else json.loads(body)


def import_task(raw, identity, expected=200):
    lines = raw.splitlines()
    call('import/begin', request_id=identity, header=lines[0])
    for line in lines[1:-1]:
        call('import/append', task_id=identity, lines=base64.b64encode((line + '\n').encode()).decode())
    return call('import/finish', expected=expected, task_id=identity, footer=lines[-1])


def context_of(rows):
    data = b''.join(base64.b64decode(row['data']) for row in rows if row['type'] == 'navigation_chunk')
    return json.loads(data) if data else None


call('init')
assert teaching.VERSION == 23
library = RouteLibrary()
existing = dict(schema_version=1, id='existing-business-route', name='已有路网', scene_name='existing-map',
                nodes=[dict(id=0, label='已有站点', x_m=100, y_m=200, yaw_rad=None)], edges=[])
library.save(existing, '')
library.mark(existing, 'ready', 'existing selection', '0' * 32, library.context())
existing_files = {file: file.read_bytes() for file in library.root.glob('*.json')}
count = 0
for bundle_path in sorted(folder.glob('*.zip')):
    with zipfile.ZipFile(bundle_path) as bundle:
        for entry in json.loads(bundle.read('manifest.json'))['tasks']:
            raw = bundle.read(entry['file']).decode()
            rows = [json.loads(line) for line in raw.splitlines()]
            source_context = context_of(rows)
            identity = f'{1000 + count:032x}'
            count += 1
            result = import_task(raw, identity)
            assert result['task']['point_count'] == entry['point_count']
            exported = [json.loads(line) for line in call('export', task_id=identity).splitlines()]
            restored_context = context_of(exported)
            expected_body = [row for row in rows[1:-1] if row['type'] != 'navigation_chunk']
            if source_context:
                mapping = {}
                assert len(source_context['routes']) == len(restored_context['routes'])
                for source, restored in zip(source_context['routes'], restored_context['routes']):
                    assert restored == dict(source, id=restored['id']), 'route topology, coordinates and scene must be unchanged'
                    assert library.get(restored['id'])['document'] == restored
                    mapping[source['id']] = restored['id']
                for row in expected_body:
                    if row['type'] == 'point':
                        for record in teaching_navigation.records(row['record']):
                            if not teaching.is_navigation(record):
                                continue
                            route_id = record.get('route_id') or source_context.get('default_route_id')
                            record['route_id'] = mapping[route_id]
                for route_file, source in zip(entry['navigation']['routes'], source_context['routes']):
                    assert json.loads(bundle.read(route_file)) == source
            else:
                # The native robot exporter may attach its current route to an
                # old node-only task. Importing it must not alter that route.
                if restored_context:
                    assert restored_context['routes'] == [existing]
                    assert restored_context['default_route_id'] == existing['id']
            actual_body = [row for row in exported[1:-1] if row['type'] != 'navigation_chunk']
            assert actual_body == expected_body, 'all parkings, poses, action IDs, camera settings and order must survive import'
            if source_context:
                models = {row['record']['robot_model'] for row in rows if row.get('record', {}).get('joints_rad')}
                plan = execution_plan.load_plan(str(database), [identity], 'mock', next(iter(models)))
                expected_nav = [row['record'] for row in expected_body if row.get('record', {}).get('type') == 'route_navigation']
                planned = [point for parking in plan['tasks'][0]['parkings'] for point in parking['points'] if point['kind'] == 'navigation']
                assert len(planned) == len(expected_nav)
                for step, record in zip(planned, expected_nav):
                    assert step['route_id'] == record['route_id'] and step['node_name'] == record['node_id']
                    route = library.get(step['route_id'])['document']
                    node = next(node for node in route['nodes'] if f'N{node["id"]}' == record['node_id'])
                    for key in ('x_m', 'y_m'):
                        assert math.isclose(step['target'][key], node[key], abs_tol=1e-6)
                    delta = step['target']['yaw_rad'] - node['yaw_rad']
                    assert abs(math.atan2(math.sin(delta), math.cos(delta))) < 1e-6
                imported_ids = {file.name for file in library.root.glob('*.json')}
                import_task(raw, f'{2000 + count:032x}')
                assert {file.name for file in library.root.glob('*.json')} == imported_ids, 'identical route must be reused'
            for file, data in existing_files.items():
                assert file.read_bytes() == data, 'existing business route and active selection must not change'
print(f'Unmodified Brain ZIP reader / native importer: {count} tasks passed, routes recovered and bound, existing route selection unchanged')
