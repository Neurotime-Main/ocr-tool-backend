"""
Wraps one already-normalised image in a single-page PDF.

Everything after the upload works in PDF pages -- the viewer, the OCR queue,
the highlight geometry, the published page image -- so an uploaded photo or scan
becomes a one-page PDF at the door rather than a second document type that every
later stage has to know about.

The page is sized so that rendering it back at the same DPI reproduces the
image's own pixels exactly: no upscaling, and no rasterising more than the
photograph ever contained. img2pdf embeds the JPEG as-is, so this costs no
quality and barely any time.
"""
import sys

import img2pdf


def main() -> int:
    if len(sys.argv) < 4:
        print("usage: image_to_pdf.py <image> <output.pdf> <dpi>", file=sys.stderr)
        return 2
    source, destination, dpi = sys.argv[1], sys.argv[2], float(sys.argv[3])

    try:
        layout = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))
        with open(destination, "wb") as handle:
            handle.write(img2pdf.convert(source, layout_fun=layout))
    except Exception as error:  # noqa: BLE001 - reported to the caller
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
