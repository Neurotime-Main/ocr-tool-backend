"""Package ordered OCR images into a PDF for the viewer after recognition."""
import pathlib
import sys

import img2pdf


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: images_to_pdf.py <frames-dir> <output.pdf> <dpi>", file=sys.stderr)
        return 2
    frames_dir, destination, dpi = pathlib.Path(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    frames = sorted(
        str(path)
        for path in frames_dir.iterdir()
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    if not frames:
        print("no frames found", file=sys.stderr)
        return 1
    try:
        layout = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))
        with open(destination, "wb") as handle:
            handle.write(img2pdf.convert(frames, layout_fun=layout))
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
