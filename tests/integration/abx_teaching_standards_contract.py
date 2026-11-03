"""Run the unmodified robot task/resource importers only against temporary data."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import zipfile

sys.dont_write_bytecode = True
folder, brain = (Path(value).resolve() for value in sys.argv[1:])


def temporary_path(value):
    if isinstance(value, (str, bytes, os.PathLike)):
        target = Path(os.fsdecode(value)).resolve()
        if target != folder and folder not in target.parents:
            raise PermissionError(f'Test cannot write outside its temporary directory: {target}')


def isolated_io(event, args):
    if event == 'open' and args[2] & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
        temporary_path(args[0])
    elif event in ('os.mkdir', 'os.remove', 'os.rmdir', 'os.chmod', 'os.utime', 'sqlite3.connect'):
        temporary_path(args[0])
    elif event in ('os.rename', 'os.link', 'os.symlink'):
        # Native reference imports use directory-relative names and descriptors.
        if os.path.isabs(args[0]): temporary_path(args[0])
        if os.path.isabs(args[1]): temporary_path(args[1])
    elif event in ('socket.connect', 'socket.bind', 'subprocess.Popen', 'os.system'):
        raise PermissionError(f'Test cannot contact robot services: {event}')


os.chdir(folder)
sys.addaudithook(isolated_io)
sys.path[:0] = [str(brain / 'tools' / name) for name in ('web', 'storage', 'chassis', 'platform', 'logging')]
import teaching_store as teaching
import teaching_references as references
import teaching_export

database = folder / 'pipeline/teaching/test.sqlite3'
os.environ['ABX_PIPELINE_ROOT'] = str(database.parent.parent)
os.environ['ABX_RUNTIME_BACKEND'] = 'mock'
spec = {'reference_root': str(folder / 'references')}


def call(operation, **args):
    output = io.StringIO()
    teaching.run(str(database), {'op': operation, 'args': args}, output)
    status, body = output.getvalue().split('\n', 1)
    assert int(status) == 200, (operation, status, body)
    return body if operation == 'export' else json.loads(body)


call('init')
count = 0
for bundle_path in sorted(folder.glob('standards-*.zip')):
    with zipfile.ZipFile(bundle_path) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        task_ids = []
        for entry in manifest['tasks']:
            count += 1
            identity = f'{count:032x}'
            task_ids.append(identity)
            lines = bundle.read(entry['file']).decode().splitlines()
            call('import/begin', request_id=identity, header=lines[0])
            for line in lines[1:-1]:
                call('import/append', task_id=identity, lines=base64.b64encode((line + '\n').encode()).decode())
            call('import/finish', task_id=identity, footer=lines[-1])
            original = [json.loads(line)['record'] for line in lines if json.loads(line)['type'] == 'point' and 'joints_rad' in json.loads(line)['record']]
            restored = [row['record'] for row in map(json.loads, call('export', task_id=identity).splitlines()) if row['type'] == 'point' and 'joints_rad' in row['record']]
            assert restored == original, 'pose values and standard resource associations must survive native import'
        # Restore clouds first, exercising cloud-only support and PNG repair.
        for entry in manifest.get('clouds', []) + manifest.get('standards', []):
            data = bundle.read(entry['path'])
            kind = entry.get('kind', 'png')
            chunk_size = 65536 if kind == 'xyzbin' else 8192
            for offset in range(0, len(data), chunk_size):
                args = dict(id=entry['id'], camera=entry['camera'], kind=kind, bytes=str(len(data)),
                    sha256=entry['sha256'], offset=str(offset), data=base64.b64encode(data[offset:offset+chunk_size]).decode(),
                    metadata=json.dumps(entry['metadata']))
                result = references.import_chunk(spec, args)
                assert references.import_chunk(spec, args) == result, 'duplicate chunks are resumable'
            assert result['complete'] is True
            directory = Path(spec['reference_root']) / entry['id']
            stored = references.read_manifest(directory)['results'][entry['camera']]
            asset = stored['cloud'] if kind == 'xyzbin' else stored
            actual = (directory / asset['file']).read_bytes()
            assert actual == data and asset['sha256'] == hashlib.sha256(data).hexdigest()
            if kind == 'xyzbin':
                assert struct.unpack('<II', data[8:16]) == (6000, 1)
                assert all(abs(a-b) < .001 for a, b in zip(struct.unpack('<fff', data[16:28]), (-200., 110., 1255.35)))
            else:
                assert stored['simulated'] is True and stored['width'] == 2 and stored['height'] == 1
        # The robot must also be able to export the imported resources again.
        snapshot = teaching_export.Snapshot(str(database), dict(task_ids=json.dumps(task_ids), include_images='false',
            include_standards=str(manifest.get('include_standards', False)).lower(),
            include_clouds=str(manifest.get('include_clouds', False)).lower()),
            config_loader=lambda _: dict(reference_root=spec['reference_root']), zivid_enabled=True, strict=True)
        try:
            output = io.BytesIO(); snapshot.write_zip(output)
            with zipfile.ZipFile(output) as again:
                exported = json.loads(again.read('manifest.json'))
                for key in ('standards', 'clouds'):
                    assert len(exported[key]) == len(manifest.get(key, []))
                    for asset in exported[key]:
                        assert again.read(asset['path']) == bundle.read(asset['path'])
        finally:
            snapshot.stack.close()
print(f'Unmodified robot import/storage/re-export passed for {count} tasks and four image/cloud selections.')
