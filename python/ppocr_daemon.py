"""
PaddleOCR PP-OCRv5 recognition daemon.

Runs the official PaddleOCR detection, angle-classification and recognition
models on ONNX Runtime and answers one page at a time over stdin/stdout.

The daemon exists because loading the three models costs far more than reading
a page does: a process per page would spend most of its life starting up. It is
kept deliberately dumb -- it owns no queue, no database and no retry policy, so
the Node worker can kill and replace it at any point without losing work.

Protocol: one JSON object per line in, one JSON object per line out.
  in : {"id": "<any>", "image": "/path/page.jpg", "maxSide": 1600}
  out: {"id": "<any>", "lines": [{"text","confidence","box":[x,y,w,h]}, ...]}
       {"id": "<any>", "error": "<message>"}
Anything written to stderr is diagnostic only and is forwarded to the Node log.
"""
import json
import os
import sys
import traceback

import cv2
import numpy as np
import onnxruntime as ort
import pyclipper
import yaml

MODEL_DIR = os.environ.get("PPOCR_MODEL_DIR", "/app/models")
# One thread by default: the Node worker runs several pages at once and sizing
# both pools from the same cores would only make them fight over the CPU.
THREADS = max(1, int(os.environ.get("PPOCR_THREADS", "1")))
MAX_CANDIDATES = max(100, int(os.environ.get("PPOCR_MAX_CANDIDATES", "1000")))
DET_LIMIT = max(320, int(os.environ.get("PPOCR_DET_MAX_SIDE", "1600")))
DET_THRESH = float(os.environ.get("PPOCR_DET_THRESH", "0.3"))
DET_BOX_THRESH = float(os.environ.get("PPOCR_DET_BOX_THRESH", "0.6"))
DET_UNCLIP = float(os.environ.get("PPOCR_DET_UNCLIP", "1.5"))
REC_MIN_SCORE = float(os.environ.get("PPOCR_REC_MIN_SCORE", "0.45"))
USE_ANGLE_CLS = os.environ.get("PPOCR_USE_ANGLE_CLS", "1") != "0"

# OpenCV sees the physical host's cores on some container platforms instead of
# the cgroup quota. Its default pool can therefore create dozens of threads for
# a daemon that is allotted one CPU, multiplying context switching across every
# concurrent page. Page-level parallelism is owned by the Node worker.
cv2.setNumThreads(THREADS)

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)


def make_session(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = THREADS
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(path, options, providers=["CPUExecutionProvider"])


def load_character_dict(path):
    """Pulls `character_dict` out of the model's own inference.yml."""
    def search(node, key):
        if isinstance(node, dict):
            for name, value in node.items():
                if name == key:
                    return value
                found = search(value, key)
                if found is not None:
                    return found
        if isinstance(node, list):
            for value in node:
                found = search(value, key)
                if found is not None:
                    return found
        return None

    with open(path, encoding="utf-8") as handle:
        return search(yaml.safe_load(handle), "character_dict")


def order_corners(points):
    """Orders four corners as top-left, top-right, bottom-right, bottom-left."""
    ordered = np.array(sorted(points, key=lambda point: point[0]), np.float32)
    left = sorted(ordered[:2], key=lambda point: point[1])
    right = sorted(ordered[2:], key=lambda point: point[1])
    return np.array([left[0], right[0], right[1], left[1]], np.float32)


class Detector:
    """PP-OCRv5 text detection with the standard DB post-process."""

    def __init__(self, path):
        self.session = make_session(path)
        self.input_name = self.session.get_inputs()[0].name

    def __call__(self, image, max_side):
        height, width = image.shape[:2]
        scale = min(max_side / max(height, width), 1.0)
        # The network needs both sides to be multiples of 32.
        net_h = max(32, int(round(height * scale / 32)) * 32)
        net_w = max(32, int(round(width * scale / 32)) * 32)
        resized = cv2.resize(image, (net_w, net_h)).astype(np.float32) / 255.0
        tensor = ((resized - IMAGENET_MEAN) / IMAGENET_STD).transpose(2, 0, 1)[None]
        probability = self.session.run(None, {self.input_name: tensor})[0][0, 0]

        mask = (probability > DET_THRESH).astype(np.uint8)
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        # PaddleOCR's own DB post-process caps candidates too. Prefer the
        # largest regions when a noisy page creates more contours than the cap.
        contours = sorted(contours, key=cv2.contourArea, reverse=True)[:MAX_CANDIDATES]
        boxes = []
        for contour in contours:
            if len(contour) < 4:
                continue
            rectangle = cv2.minAreaRect(contour)
            if min(rectangle[1]) < 3:
                continue
            # Mean probability inside the contour is the box's own score. The
            # old implementation allocated and scanned a full detector-sized
            # mask for every contour (up to 3000 full-page scans). Score only
            # the contour's bounding crop, as PaddleOCR's fast path does.
            x, y, box_width, box_height = cv2.boundingRect(contour)
            score_mask = np.zeros((box_height, box_width), np.uint8)
            shifted = contour.reshape(-1, 2) - np.array([x, y])
            cv2.fillPoly(score_mask, [shifted.astype(np.int32)], 1)
            score = cv2.mean(probability[y:y + box_height, x:x + box_width], score_mask)[0]
            if score < DET_BOX_THRESH:
                continue
            corners = cv2.boxPoints(rectangle)
            area = abs(cv2.contourArea(corners))
            perimeter = cv2.arcLength(corners, True)
            if area < 1 or perimeter <= 0:
                continue
            # DB shrinks every region during training, so it is grown back here.
            distance = area * DET_UNCLIP / perimeter
            offset = pyclipper.PyclipperOffset()
            offset.AddPath(corners.astype(np.int64).tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
            expanded = offset.Execute(distance)
            if not expanded:
                continue
            grown = cv2.minAreaRect(np.array(expanded[0], np.int32))
            if min(grown[1]) < 3:
                continue
            points = cv2.boxPoints(grown)
            points[:, 0] = np.clip(points[:, 0] / net_w * width, 0, width)
            points[:, 1] = np.clip(points[:, 1] / net_h * height, 0, height)
            boxes.append((order_corners(points), float(score)))
        return boxes


def crop_box(image, box):
    """Deskews one detected region into an upright strip."""
    width = int(max(np.linalg.norm(box[0] - box[1]), np.linalg.norm(box[2] - box[3])))
    height = int(max(np.linalg.norm(box[0] - box[3]), np.linalg.norm(box[1] - box[2])))
    if width < 2 or height < 2:
        return None
    target = np.array([[0, 0], [width, 0], [width, height], [0, height]], np.float32)
    warped = cv2.warpPerspective(
        image, cv2.getPerspectiveTransform(box, target), (width, height),
        borderMode=cv2.BORDER_REPLICATE,
    )
    # A strip taller than it is wide is a vertical line of text; stand it up.
    if height / max(width, 1) >= 1.5:
        warped = np.rot90(warped)
    return np.ascontiguousarray(warped)


class AngleClassifier:
    """Points out crops that may be rotated by 180 degrees.

    It suggests rather than decides, because on its own it is not reliable
    enough to act on. Measured on a broadsheet page it wanted to flip 5 of 441
    crops and was wrong about 3 of them, turning a legible sentence into
    gibberish; on an Azerbaijani post image it was wrong about 4 of 7. It says
    so with near-certainty in those cases -- scores of 0.94 to 1.00 -- so no
    threshold separates its mistakes from its successes.

    What does separate them is asking the recogniser, which is a far larger
    model and reads the wrong way up badly. So this returns the indices it is
    suspicious of and `Engine.read` reads those crops both ways round, keeping
    whichever the recogniser is surer of. Only flagged crops pay for the second
    pass -- about one percent of a newspaper page.
    """

    SHAPE = (3, 48, 192)

    def __init__(self, path):
        self.session = make_session(path)
        self.input_name = self.session.get_inputs()[0].name

    def __call__(self, crops):
        channels, height, width = self.SHAPE
        suspected = set()
        for index, crop in enumerate(crops):
            scaled_w = min(width, max(1, int(height * crop.shape[1] / max(crop.shape[0], 1))))
            tensor = np.zeros((1, channels, height, width), np.float32)
            resized = cv2.resize(crop, (scaled_w, height)).astype(np.float32) / 255.0
            tensor[0, :, :, :scaled_w] = ((resized - 0.5) / 0.5).transpose(2, 0, 1)
            scores = self.session.run(None, {self.input_name: tensor})[0][0]
            if scores[1] > 0.9:
                suspected.add(index)
        return suspected


class Recognizer:
    """PP-OCRv5 recognition with a CTC greedy decode.

    Runs one crop per call on purpose. This ONNX export loses throughput as the
    batch grows -- measured at roughly half the per-crop speed at batch 8 -- so
    batching would cost time rather than save it.
    """

    HEIGHT = 48

    def __init__(self, model_path, config_path):
        self.session = make_session(model_path)
        self.input_name = self.session.get_inputs()[0].name
        # Index 0 is the CTC blank; the trailing space matches PaddleOCR's own
        # `use_space_char` handling.
        self.charset = ["<blank>"] + list(load_character_dict(config_path)) + [" "]

    def __call__(self, crop):
        ratio = crop.shape[1] / max(crop.shape[0], 1)
        width = max(16, int(np.ceil(self.HEIGHT * ratio / 8) * 8))
        resized = cv2.resize(crop, (width, self.HEIGHT)).astype(np.float32) / 255.0
        tensor = ((resized - 0.5) / 0.5).transpose(2, 0, 1)[None]
        logits = self.session.run(None, {self.input_name: tensor})[0][0]
        indices = logits.argmax(1)
        confidences = logits.max(1)

        characters, scores, previous = [], [], -1
        for position, index in enumerate(indices):
            if index != 0 and index != previous and index < len(self.charset):
                characters.append(self.charset[index])
                scores.append(confidences[position])
            previous = index
        text = "".join(characters).strip()
        return text, float(np.mean(scores)) if scores else 0.0


class Engine:
    def __init__(self):
        self.detector = Detector(os.path.join(MODEL_DIR, "det.onnx"))
        self.recognizers = {}
        self.classifier = (
            AngleClassifier(os.path.join(MODEL_DIR, "cls.onnx")) if USE_ANGLE_CLS else None
        )

    def recognizer(self, script):
        """Recognition models are per script and loaded the first time they are
        asked for, so a deployment that only ever sees one language never pays
        for the others."""
        name = "cyrillic" if script == "cyrillic" else "latin"
        if name not in self.recognizers:
            self.recognizers[name] = Recognizer(
                os.path.join(MODEL_DIR, f"rec_{name}.onnx"),
                os.path.join(MODEL_DIR, f"rec_{name}.yml"),
            )
        return self.recognizers[name]

    def read(self, image_path, max_side, scripts):
        image = cv2.imread(image_path, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"Could not read the rendered page at {image_path}")
        height, width = image.shape[:2]
        boxes = self.detector(image, max_side)
        if not boxes:
            return []

        crops, keep = [], []
        for box, _score in boxes:
            crop = crop_box(image, box)
            if crop is not None:
                crops.append(crop)
                keep.append(box)
        if not crops:
            return []
        upside_down = self.classifier(crops) if self.classifier is not None else set()

        recognizers = [self.recognizer(script) for script in scripts if script in ("latin", "cyrillic")]
        if not recognizers:
            recognizers = [self.recognizer("latin")]

        def read_crop(crop):
            # A page can contain both Latin and Russian text. Each selected
            # script reads the same crop and the stronger recognition score is
            # retained, while Azerbaijani and English share one Latin pass.
            return max((recognizer(crop) for recognizer in recognizers), key=lambda result: result[1])

        lines = []
        for index, (box, crop) in enumerate(zip(keep, crops)):
            text, score = read_crop(crop)
            if index in upside_down:
                # The classifier thinks this one is upside down. Read it that
                # way too and believe whichever reading the recogniser is
                # surer of, rather than the classifier.
                rotated_text, rotated_score = read_crop(np.ascontiguousarray(np.rot90(crop, 2)))
                if rotated_score > score:
                    text, score = rotated_text, rotated_score
            if not text or score < REC_MIN_SCORE:
                continue
            left = float(np.min(box[:, 0]))
            top = float(np.min(box[:, 1]))
            right = float(np.max(box[:, 0]))
            bottom = float(np.max(box[:, 1]))
            lines.append({
                "text": text,
                "confidence": round(score * 100, 2),
                # Normalised to the page so the caller never needs the raster.
                "box": [left / width, top / height, (right - left) / width, (bottom - top) / height],
            })
        # Reading order: top to bottom, then left to right.
        lines.sort(key=lambda line: (round(line["box"][1], 3), line["box"][0]))
        return lines


def main():
    engine = Engine()
    # Tells the supervisor the models are loaded and the daemon can be used.
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request_id = None
        try:
            request = json.loads(raw)
            request_id = request.get("id")
            lines = engine.read(
                request["image"],
                int(request.get("maxSide", DET_LIMIT)),
                request.get("languages", ["latin"]),
            )
            response = {"id": request_id, "lines": lines}
        except Exception as error:  # noqa: BLE001 - reported to the caller instead
            traceback.print_exc(file=sys.stderr)
            response = {"id": request_id, "error": f"{type(error).__name__}: {error}"}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
