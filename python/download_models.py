"""
Fetches the PaddleOCR PP-OCRv5 models the daemon runs.

They are pulled at image build time rather than vendored into git: together
they are about 13 MB, and keeping them out of the repository means a model
upgrade is a rebuild rather than a commit. Each file is size-checked, because a
truncated download would otherwise surface much later as an ONNX parse error on
the first page a worker touches.
"""
import os
import sys
import urllib.request

HUGGINGFACE = "https://huggingface.co"
MODELS = {
    # PP-OCRv5 mobile text detection, script independent.
    "det.onnx": (f"{HUGGINGFACE}/bukuroo/PPOCRv5-ONNX/resolve/main/ppocrv5-mobile-det.onnx", 4_000_000),
    # 180-degree orientation classifier.
    "cls.onnx": (f"{HUGGINGFACE}/bukuroo/PPOCRv5-ONNX/resolve/main/ppocrv5-cls.onnx", 400_000),
    # Latin recognition: the official PaddleOCR latin_PP-OCRv5_mobile_rec
    # weights, which cover English and Azerbaijani Latin.
    "rec_latin.onnx": (f"{HUGGINGFACE}/itextresearch/itext-latin_PP-OCRv5_mobile_rec_infer/resolve/main/inference.onnx", 7_000_000),
    "rec_latin.yml": (f"{HUGGINGFACE}/itextresearch/itext-latin_PP-OCRv5_mobile_rec_infer/resolve/main/inference.yml", 3_000),
}


def download(destination):
    os.makedirs(destination, exist_ok=True)
    for name, (url, minimum_bytes) in MODELS.items():
        target = os.path.join(destination, name)
        if os.path.exists(target) and os.path.getsize(target) >= minimum_bytes:
            print(f"  {name}: already present")
            continue
        print(f"  {name}: downloading")
        request = urllib.request.Request(url, headers={"User-Agent": "markwise-ocr"})
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = response.read()
        if len(payload) < minimum_bytes:
            raise SystemExit(f"{name} downloaded only {len(payload)} bytes; expected at least {minimum_bytes}")
        with open(target, "wb") as handle:
            handle.write(payload)
        print(f"  {name}: {len(payload) / 1e6:.1f} MB")


if __name__ == "__main__":
    download(sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PPOCR_MODEL_DIR", "/app/models"))
    print("PaddleOCR models ready")
