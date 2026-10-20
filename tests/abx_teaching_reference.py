"""Copy only importer dependencies out of workspace.zip, without extracting workspace."""
from pathlib import Path, PurePosixPath
import sys
import zipfile

source, destination = (Path(value).resolve() for value in sys.argv[1:])
prefix = 'workspace/ABXBrainSystem/'
with zipfile.ZipFile(source, 'r') as archive:
    for member in archive.infolist():
        if not member.filename.startswith(prefix) or member.is_dir():
            continue
        relative = PurePosixPath(member.filename[len(prefix):])
        if '..' in relative.parts or relative.is_absolute():
            raise ValueError('Invalid reference path')
        selected = (len(relative.parts) == 3 and relative.parts[0] == 'tools'
                    and relative.parts[1] in ('web', 'chassis', 'platform', 'logging', 'storage')
                    and relative.suffix == '.py') or str(relative) == 'web/teaching-import.js'
        if selected:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(member))
            target.chmod(0o444)
assert (destination / 'tools/web/teaching_store.py').is_file(), 'workspace.zip lacks ABXBrainSystem importer'
