from topbar_tools_helpers import topbar_action

import json
import struct
import zipfile
from pathlib import Path


PROJECT_CONFIG_PATH = "config/project.json"


def logical_manifest(manifest):
    return manifest.get("projectManifest", manifest)


def logical_archive_files(archive):
    """Independent decoder for inspecting both legacy and shared-resource ZIPs."""
    physical = {name: archive.read(name) for name in archive.namelist() if not name.endswith("/")}
    envelope = json.loads(physical["manifest.json"])
    if envelope.get("format") != "atlas-route-studio-resource-project":
        return physical
    result = {"manifest.json": json.dumps(envelope["projectManifest"]).encode()}
    for record in envelope["projectManifest"]["files"]:
        name = record["path"]
        reference = envelope["references"].get(name)
        if not reference:
            result[name] = physical[name]
        elif "resource" in reference:
            result[name] = physical[reference["resource"]]
        else:
            pieces = []
            for part in reference["parts"]:
                data = physical[part["resource"]]
                if part["kind"] == "positions":
                    e = part["matrix"]
                    data = b"".join(struct.pack("<fff",
                        e[0] * x + e[4] * y + e[8] * z + e[12],
                        e[1] * x + e[5] * y + e[9] * z + e[13],
                        e[2] * x + e[6] * y + e[10] * z + e[14])
                        for x, y, z in struct.iter_unpack("<fff", data))
                elif part["kind"] == "indices":
                    data = b"".join(struct.pack("<I", value + part["offset"])
                        for value, in struct.iter_unpack("<H" if part["stride"] == 2 else "<I", data))
                pieces.append(data)
            result[name] = b"".join(pieces)
    return result


def active_project_path(manifest):
    manifest = logical_manifest(manifest)
    workspace = manifest.get("workspaces", {}).get(manifest.get("activeMode"))
    return workspace["prefix"] + PROJECT_CONFIG_PATH if workspace else PROJECT_CONFIG_PATH


def start_project_download(page, name=None):
    """Use the browser fallback so existing ZIP-content tests get a Download."""
    page.evaluate("window.showSaveFilePicker = undefined")
    label = "导出工程" if page.locator('[data-app-page="teaching-data"]:visible').count() else "另存为工程"
    topbar_action(page, name=label, exact=True).click()
    dialog = page.get_by_role("dialog", name="保存工程副本")
    if name is not None:
        dialog.get_by_label("工程名称", exact=True).fill(name)
    dialog.get_by_role("button", name="保存工程 ZIP", exact=True).click()


def read_exported_project(download):
    path = Path(download.path())
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            return json.loads(archive.read(active_project_path(manifest)))
    return json.loads(path.read_text())


def read_exported_archive(download):
    path = Path(download.path())
    assert zipfile.is_zipfile(path), f"expected ZIP archive: {path}"
    with zipfile.ZipFile(path) as archive:
        files = logical_archive_files(archive)
        names = list(files)
        manifest = json.loads(files["manifest.json"])
        project_bytes = files[active_project_path(manifest)]
        project = json.loads(project_bytes)
        return {
            "path": path,
            "names": names,
            "manifest": manifest,
            "project": project,
            "project_bytes": project_bytes,
            "files": files,
        }
