"""Copy only importer dependencies from the supplied Brain source archive."""
from pathlib import Path, PurePosixPath
import sys
import zipfile

source, destination = (Path(value).resolve() for value in sys.argv[1:])
with zipfile.ZipFile(source, 'r') as archive:
    prefixes = [prefix for prefix in ('ABXBrainSystem/', 'workspace/ABXBrainSystem/')
                if prefix + 'tools/web/teaching_store.py' in archive.namelist()]
    assert len(prefixes) == 1, 'Source ZIP must contain exactly one known ABXBrainSystem root'
    prefix = prefixes[0]
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
assert (destination / 'tools/web/teaching_store.py').is_file(), 'Source ZIP lacks ABXBrainSystem importer'
