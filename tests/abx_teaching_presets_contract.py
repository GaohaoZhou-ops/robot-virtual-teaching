"""Import Atlas preset libraries with the unmodified robot storage worker."""
import base64
import io
import json
import os
from pathlib import Path
import sqlite3
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

database = folder / 'pipeline/teaching/test.sqlite3'
os.environ['ABX_PIPELINE_ROOT'] = str(database.parent.parent)
os.environ['ABX_RUNTIME_BACKEND'] = 'mock'


def call(operation, **args):
    output = io.StringIO()
    teaching.run(str(database), {'op': operation, 'args': args}, output)
    status, body = output.getvalue().split('\n', 1)
    assert int(status) == 200, (operation, status, body)
    return json.loads(body)


call('init')
expected = {}
with zipfile.ZipFile(folder / 'presets.zip') as bundle:
    entries = json.loads(bundle.read('manifest.json'))['tasks']
    for repeat in range(2):
        for index, entry in enumerate(entries):
            identity = f'{1000 + repeat * len(entries) + index:032x}'
            lines = bundle.read(entry['file']).decode().splitlines()
            rows = [json.loads(line) for line in lines]
            expected.update({row['id']: row for row in rows if row['type'] == 'basic_pose'})
            call('import/begin', request_id=identity, header=lines[0])
            for line in lines[1:-1]:
                call('import/append', task_id=identity, lines=base64.b64encode((line + '\n').encode()).decode())
            imported = call('import/finish', task_id=identity, footer=lines[-1])
            assert imported['task']['point_count'] == entry['point_count'], 'library import must not insert task steps'
        with sqlite3.connect(database) as db:
            for identity, preset in expected.items():
                row = db.execute('SELECT name,record,created_ns,updated_ns FROM atomic_actions WHERE id=?', (identity,)).fetchone()
                assert row is not None, f'Preset missing from the robot action library: {preset["name"]}'
                assert row[0] == preset['name'] and json.loads(row[1]) == preset['record']
                assert row[2:] == (preset['created_ns'], preset['updated_ns'])
                assert db.execute('SELECT COUNT(*) FROM atomic_actions WHERE name=?', (preset['name'],)).fetchone()[0] == 1
print(f'Unmodified robot importer: {len(expected)} presets restored to the shared library; repeated multi-task imports reuse templates')
