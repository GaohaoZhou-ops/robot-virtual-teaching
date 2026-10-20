"""Exercise unchanged deployed readers using disposable copies and no robot I/O."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import zipfile
from urllib.parse import unquote, urlparse

sys.dont_write_bytecode = True
operation, folder_arg, brain_arg, workspace_arg = sys.argv[1:]
folder, brain, workspace = map(lambda v: Path(v).resolve(), (folder_arg, brain_arg, workspace_arg))


def confined(path):
    if isinstance(path, (str, bytes, os.PathLike)):
        decoded = os.fsdecode(path)
        if decoded.startswith('file:'):
            decoded = unquote(urlparse(decoded).path)
        target = Path(decoded).resolve()
        if target != folder and folder not in target.parents:
            raise PermissionError(f'Contract test cannot write outside temporary directory: {target}')


def audit(event, args):
    if event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        confined(args[0])
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'sqlite3.connect'):
        # All databases used below are disposable copies.
        confined(args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        confined(args[0]); confined(args[1])
    elif event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise PermissionError(f'Contract test cannot contact external services: {event}')


sys.addaudithook(audit)
sys.path[:0] = [str(brain / 'tools/web'), str(brain / 'tools/chassis')]
import teaching_store as teaching
from route_library import RouteLibrary, validate as validate_route

pipeline = folder / operation / 'pipeline'
pipeline.mkdir(parents=True, exist_ok=True)
os.environ['ABX_PIPELINE_ROOT'] = str(pipeline)
os.environ['ABX_RUNTIME_BACKEND'] = 'mock'
database = pipeline / 'teaching.sqlite3'


def call(op, **args):
    output = io.StringIO()
    teaching.run(str(database), dict(op=op, args=args), output, pipeline_root=pipeline, backend='mock')
    status, body = output.getvalue().split('\n', 1)
    assert status == '200', (op, status, body)
    return body if op == 'export' else json.loads(body)


if operation == 'fixtures':
    with zipfile.ZipFile(workspace, 'r') as archive:
        source = 'workspace/abxpipeline/simulation/host/teaching.sqlite3'
        for suffix in ('', '-wal', '-shm'):
            if source + suffix in archive.namelist():
                (pipeline / ('teaching.sqlite3' + suffix)).write_bytes(archive.read(source + suffix))
        route_dir = pipeline / 'routes'
        route_dir.mkdir()
        for member in archive.namelist():
            if member.startswith('workspace/abxpipeline/routes/') and member.endswith('.json'):
                (route_dir / Path(member).name).write_bytes(archive.read(member))
        # Include the deployment's actual route as a standalone fixture.
        route_path = next(route_dir.glob('*.route.json'))
        (folder / 'deployed.route.json').write_bytes(route_path.read_bytes())
    connection = sqlite3.connect(database)
    identities = [row[0] for row in connection.execute('SELECT id FROM tasks WHERE visible=1 ORDER BY created_ns,id')]
    connection.close()
    assert identities, 'Reference deployment has no teaching tasks'
    manifest = dict(schema='abx-teaching-export', version=1, tasks=[], images=[], include_images=False)
    with zipfile.ZipFile(folder / 'deployed-teaching.zip', 'w', zipfile.ZIP_STORED) as bundle:
        for identity in identities:
            output = io.StringIO()
            teaching.run(str(database), dict(op='export', args=dict(task_id=identity), read_only=True), output,
                         pipeline_root=pipeline, backend='mock')
            status, raw = output.getvalue().split('\n', 1)
            assert status == '200', raw
            header = json.loads(raw.splitlines()[0])
            file = f'tasks/{identity}.abxteach.ndjson'
            manifest['tasks'].append(dict(id=identity, file=file, name=header['name'],
                **{key: header[key] for key in ('point_count', 'parking_count', 'basic_pose_count')}))
            bundle.writestr(file, raw)
        bundle.writestr('manifest.json', json.dumps(manifest))
    print(f"Exported {len(identities)} real deployed tasks using the unchanged read-only robot exporter")
else:
    call('init')
    library = RouteLibrary(pipeline, 'mock')
    route = json.loads((folder / 'deployed.route.json').read_text())
    existing = dict(route, id='existing-business-route')
    library.save(existing, '')
    library.mark(existing, 'ready', 'existing selection', '0' * 32, library.context())
    untouched = {p: p.read_bytes() for p in library.root.glob('*.json')}
    for path in (folder / 'route-exports').glob('*.json'):
        validate_route(json.loads(path.read_text()))
    imported_count = 0
    for name in ('roundtrip.zip', 'edited.zip', 'synthetic.zip'):
        with zipfile.ZipFile(folder / name) as bundle:
            manifest = json.loads(bundle.read('manifest.json'))
            for entry in manifest['tasks']:
                lines = bundle.read(entry['file']).decode().rstrip('\n').split('\n')
                identity = f'{imported_count + 1000:032x}'
                call('import/begin', request_id=identity, header=lines[0])
                for line in lines[1:-1]:
                    call('import/append', task_id=identity, lines=base64.b64encode((line + '\n').encode()).decode())
                call('import/finish', task_id=identity, footer=lines[-1])
                exported = call('export', task_id=identity).rstrip('\n').split('\n')
                def records(values):
                    return [v for line in values[1:-1] if (v := json.loads(line))['type'] not in ('navigation_chunk', 'basic_pose')]
                before, after = records(lines), records(exported)
                def remove_imported_route_id(value):
                    if isinstance(value, dict):
                        return {k: remove_imported_route_id(v) for k, v in value.items() if k != 'route_id'}
                    if isinstance(value, list):
                        return [remove_imported_route_id(v) for v in value]
                    return value
                assert remove_imported_route_id(before) == remove_imported_route_id(after), 'Robot re-export changed task records'
                imported_count += 1
    assert all(p.read_bytes() == data for p, data in untouched.items()), 'Existing route or active selection changed'
    print(f"Robot accepted {imported_count} round-trip/edited tasks and all standalone routes; existing business selection unchanged")
