/** Geometry of the picture cropper: a square frame with the image panned and zoomed behind it. */

export type Crop = {
  /** 1 = the image just covers the frame; larger zooms in. */
  zoom: number;
  /** Where the image's centre sits, as a fraction of the image (0..1), so it survives zooming. */
  cx: number;
  cy: number;
};

export const MAX_ZOOM = 4;

export const centered: Crop = { zoom: 1, cx: 0.5, cy: 0.5 };

/** Pixels per image pixel at zoom 1: the smaller side exactly fills the frame. */
function coverScale(width: number, height: number, frame: number): number {
  return frame / Math.min(width, height);
}

/** Keeps the frame inside the image, so there are never empty bands in the result. */
export function clampCrop(crop: Crop, width: number, height: number, frame: number): Crop {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, crop.zoom));
  const scale = coverScale(width, height, frame) * zoom;
  const halfX = frame / 2 / scale / width;
  const halfY = frame / 2 / scale / height;
  return {
    zoom,
    cx: Math.min(1 - halfX, Math.max(halfX, crop.cx)),
    cy: Math.min(1 - halfY, Math.max(halfY, crop.cy)),
  };
}

/** Top-left of the image in frame pixels, and its displayed size. */
export function placement(crop: Crop, width: number, height: number, frame: number) {
  const scale = coverScale(width, height, frame) * crop.zoom;
  return {
    left: frame / 2 - crop.cx * width * scale,
    top: frame / 2 - crop.cy * height * scale,
    width: width * scale,
    height: height * scale,
  };
}

/** The part of the source image inside the frame. */
export function sourceRect(crop: Crop, width: number, height: number, frame: number) {
  const scale = coverScale(width, height, frame) * crop.zoom;
  const size = frame / scale;
  return { x: crop.cx * width - size / 2, y: crop.cy * height - size / 2, size };
}

/** Moves the crop by a drag of (dx, dy) frame pixels: the image follows the pointer. */
export function panBy(crop: Crop, dx: number, dy: number, width: number, height: number, frame: number): Crop {
  const scale = coverScale(width, height, frame) * crop.zoom;
  return clampCrop({ ...crop, cx: crop.cx - dx / scale / width, cy: crop.cy - dy / scale / height }, width, height, frame);
}
