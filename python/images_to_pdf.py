"""Package ordered OCR images into a PDF for the viewer after recognition.

The PDF is written one page at a time straight to disk. img2pdf builds the
whole document in memory, which for an hour of video frames meant gigabytes of
RAM and an OOM kill; here memory stays flat however many frames there are.

JPEGs are embedded as-is (DCTDecode), exactly as img2pdf did, and each page is
sized so that rendering it back at <dpi> reproduces the image's own pixels.
"""
import io
import pathlib
import shutil
import sys

from PIL import Image

JPEG_SUFFIXES = {".jpg", ".jpeg"}
COLOR_SPACES = {"L": b"/DeviceGray", "RGB": b"/DeviceRGB", "YCbCr": b"/DeviceRGB", "CMYK": b"/DeviceCMYK"}


def jpeg_source(path: pathlib.Path):
    """Returns (width, height, colour space, decode array, stream opener, length)."""
    with Image.open(path) as image:
        width, height, mode, fmt = image.width, image.height, image.mode, image.format
        adobe = "adobe" in image.info
    if fmt == "JPEG" and mode in COLOR_SPACES:
        # Adobe-written CMYK JPEGs store inverted values.
        decode = b" /Decode [1 0 1 0 1 0 1 0]" if mode == "CMYK" and adobe else b""
        return width, height, COLOR_SPACES[mode], decode, lambda: open(path, "rb"), path.stat().st_size

    # Anything else (PNG, palette or alpha JPEG) is re-encoded once, in memory,
    # one page at a time.
    with Image.open(path) as image:
        converted = image.convert("L" if image.mode in {"1", "L", "LA"} else "RGB")
    buffer = io.BytesIO()
    converted.save(buffer, format="JPEG", quality=95, subsampling=0)
    data = buffer.getvalue()
    return converted.width, converted.height, COLOR_SPACES[converted.mode], b"", lambda: io.BytesIO(data), len(data)


def write_pdf(frames: list[pathlib.Path], destination: str, dpi: float) -> None:
    offsets: list[int] = []
    page_ids = [3 + index * 3 for index in range(len(frames))]

    with open(destination, "wb") as handle:
        def begin(object_id: int) -> None:
            assert object_id == len(offsets) + 1
            offsets.append(handle.tell())
            handle.write(b"%d 0 obj\n" % object_id)

        handle.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        begin(1)
        handle.write(b"<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        begin(2)
        kids = b" ".join(b"%d 0 R" % page_id for page_id in page_ids)
        handle.write(b"<< /Type /Pages /Kids [%s] /Count %d >>\nendobj\n" % (kids, len(frames)))

        for index, frame in enumerate(frames):
            page_id = page_ids[index]
            width, height, color_space, decode, opener, length = jpeg_source(frame)
            page_width = width * 72.0 / dpi
            page_height = height * 72.0 / dpi
            size = b"%.4f %.4f" % (page_width, page_height)

            begin(page_id)
            handle.write(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s] /Contents %d 0 R "
                b"/Resources << /XObject << /Im0 %d 0 R >> >> >>\nendobj\n" % (size, page_id + 1, page_id + 2)
            )
            content = b"q\n%.4f 0 0 %.4f 0 0 cm\n/Im0 Do\nQ\n" % (page_width, page_height)
            begin(page_id + 1)
            handle.write(b"<< /Length %d >>\nstream\n%s\nendstream\nendobj\n" % (len(content), content))
            begin(page_id + 2)
            handle.write(
                b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace %s "
                b"/BitsPerComponent 8 /Filter /DCTDecode%s /Length %d >>\nstream\n"
                % (width, height, color_space, decode, length)
            )
            with opener() as source:
                shutil.copyfileobj(source, handle, 1024 * 1024)
            handle.write(b"\nendstream\nendobj\n")

        xref = handle.tell()
        handle.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(offsets) + 1))
        handle.writelines(b"%010d 00000 n \n" % offset for offset in offsets)
        handle.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(offsets) + 1, xref))


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: images_to_pdf.py <frames-dir> <output.pdf> <dpi>", file=sys.stderr)
        return 2
    frames_dir, destination, dpi = pathlib.Path(sys.argv[1]), sys.argv[2], float(sys.argv[3])
    frames = sorted(
        path
        for path in frames_dir.iterdir()
        if path.is_file() and path.suffix.lower() in JPEG_SUFFIXES | {".png"}
    )
    if not frames:
        print("no frames found", file=sys.stderr)
        return 1
    try:
        write_pdf(frames, destination, dpi)
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
