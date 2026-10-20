from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from teaching_transfer_ui_smoke import CHROME, open_transfer, ready, seed, snapshot


MATRIX_PATH = Path(__file__).resolve().parent / "fixtures" / "position_0.txt"
ROWS = [[float(value) for value in row.split()] for row in MATRIX_PATH.read_text().splitlines()]


def load_matrix(page, dialog, file):
    with page.expect_file_chooser() as chooser:
        dialog.get_by_role("button", name="加载转换矩阵", exact=True).click()
    chooser.value.set_files(file)
    expect(dialog.locator(".transfer-form")).to_have_attribute("aria-busy", "false")


def pose_values(dialog, prefix="放置"):
    return [float(dialog.get_by_label(f"{prefix} {axis}", exact=True).input_value())
            for axis in ("X", "Y", "Z", "Roll", "Pitch", "Yaw")]


def transformed(position, extra_x=0, inverse=False):
    values = [position[axis] for axis in ("x", "y", "z")]
    if inverse:
        return [sum(ROWS[row][axis] * (values[row] - ROWS[row][3]) for row in range(3))
                for axis in range(3)]
    return [sum(ROWS[row][axis] * values[axis] for axis in range(3))
            + ROWS[row][3] + (extra_x if row == 0 else 0) for row in range(3)]


def close_position(actual, expected):
    assert all(abs(actual[axis] - expected[index]) < 5e-5
               for index, axis in enumerate(("x", "y", "z"))), (actual, expected)


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, **({"executable_path": str(CHROME)} if CHROME.exists() else {}))
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map", "independent"], "independent")
            source = snapshot(page, "independent")
            target = snapshot(page, "map")
            dialog = open_transfer(page)
            expect(dialog.get_by_label("放置定位基准")).to_have_value("center")
            expect(dialog.locator('input[type="file"]')).to_be_hidden()
            load_matrix(page, dialog, str(MATRIX_PATH))
            expect(dialog.get_by_label("放置定位基准")).to_have_value("origin")
            expect(dialog.locator(".transfer-matrix-file")).to_contain_text("position_0.txt")
            values = pose_values(dialog)
            assert all(abs(values[index] - ROWS[index][3]) < 1e-6 for index in range(3))
            assert abs(values[5] - 179.583867) < 2e-5
            assert snapshot(page, "map") == target, "loading a matrix must only update the preview"

            # A rejected file must preserve both the current anchor and all six inputs.
            invalid = {"name": "invalid.txt", "mimeType": "text/plain", "buffer": b"1 0 0 0\n0 1 0 0"}
            load_matrix(page, dialog, invalid)
            expect(dialog.get_by_role("alert")).to_contain_text("4 行")
            expect(dialog.get_by_role("alert")).to_contain_text("原转换参数已保留")
            assert pose_values(dialog) == values
            expect(dialog.get_by_label("放置定位基准")).to_have_value("origin")

            # Same-file imports reset edits and clear errors; all manual controls remain usable.
            dialog.get_by_label("放置 X", exact=True).fill("12")
            load_matrix(page, dialog, str(MATRIX_PATH))
            expect(dialog.get_by_role("alert")).to_have_count(0)
            assert pose_values(dialog) == values
            dialog.get_by_label("放置定位基准").select_option("robot")
            dialog.get_by_label("放置定位基准").select_option("origin")
            assert all(abs(a - b) < 1e-6 for a, b in zip(pose_values(dialog), values))
            dialog.get_by_label("放置 X", exact=True).fill(str(ROWS[0][3] + 1))
            edited = pose_values(dialog)
            load_matrix(page, dialog, [])
            assert pose_values(dialog) == edited
            dialog.get_by_role("button", name="旋转组件", exact=True).click()
            expect(dialog.get_by_role("button", name="旋转组件", exact=True)).to_have_attribute("aria-pressed", "true")
            page.screenshot(path="/tmp/atlas-transfer-matrix-placement.png", full_page=True)
            dialog.get_by_role("button", name="放置并进入地图", exact=True).click()
            ready(page, "map")
            placed = snapshot(page, "map")
            assert placed["positions"][:len(target["positions"])] == target["positions"]
            for offset in range(0, len(source["positions"]), 3):
                original = dict(zip(("x", "y", "z"), source["positions"][offset:offset + 3]))
                actual = dict(zip(("x", "y", "z"), placed["positions"][len(target["positions"]) + offset:
                                                                        len(target["positions"]) + offset + 3]))
                close_position(actual, transformed(original, extra_x=1))
            close_position(placed["project"]["robot"]["origin"]["position"],
                           transformed(source["project"]["robot"]["origin"]["position"], extra_x=1))
            original_stop = source["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"][0]
            placed_stop = placed["project"]["virtualTeaching"]["tasks"][1]["parkingPoints"][0]
            close_position(placed_stop["mapPose"]["position"], transformed(original_stop["mapPose"]["position"], extra_x=1))
            assert snapshot(page, "independent")["positions"] == source["positions"]
            page.reload(wait_until="networkidle")
            ready(page, "map")
            assert snapshot(page, "map")["positions"] == placed["positions"]
            page.close()

            # Extraction uses the inverse and records the relation for an unchanged writeback flow.
            page = browser.new_page(viewport={"width": 1440, "height": 1000})
            page.on("pageerror", lambda error: errors.append(str(error)))
            seed(page, ["map"], "map")
            target = snapshot(page, "map")
            dialog = open_transfer(page)
            crop = [field.input_value() for field in dialog.locator(".transfer-range-grid input").all()]
            load_matrix(page, dialog, str(MATRIX_PATH))
            assert [field.input_value() for field in dialog.locator(".transfer-range-grid input").all()] == crop
            assert all(abs(pose_values(dialog, "局部原点")[index] - ROWS[index][3]) < 1e-6 for index in range(3))
            dialog.get_by_role("button", name="提取并进入独立示教", exact=True).click()
            ready(page, "independent")
            extracted = snapshot(page, "independent")
            close_position(extracted["project"]["robot"]["origin"]["position"],
                           transformed(target["project"]["robot"]["origin"]["position"], inverse=True))
            assert snapshot(page, "map")["positions"] == target["positions"]
            dialog = open_transfer(page)
            expect(dialog.get_by_role("button", name="加载转换矩阵", exact=True)).to_have_count(0)
            saved_relation = pose_values(dialog)
            dialog.get_by_role("button", name="作为新工位放置", exact=True).click()
            load_matrix(page, dialog, str(MATRIX_PATH))
            dialog.get_by_label("放置 X", exact=True).fill("25")
            dialog.get_by_role("button", name="回写原地图", exact=True).click()
            assert pose_values(dialog) == saved_relation
            expect(dialog.get_by_label("放置 X", exact=True)).to_have_attribute("readonly", "")
            dialog.get_by_role("button", name="回写并进入地图", exact=True).click()
            ready(page, "map")
            returned = snapshot(page, "map")
            assert returned["positions"] == target["positions"]
            close_position(returned["project"]["robot"]["origin"]["position"],
                           list(target["project"]["robot"]["origin"]["position"].values()))
            assert not errors, errors
            print("matrix_file_preview_errors_repeat_import_and_manual_adjustment=ok")
            print("matrix_placement_coordinates_source_preservation_and_reload=ok")
            print("matrix_extraction_inverse_and_saved_writeback_relation=ok")
        finally:
            browser.close()


if __name__ == "__main__":
    run()
