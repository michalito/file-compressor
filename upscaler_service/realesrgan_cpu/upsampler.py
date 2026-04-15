from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import cv2
import numpy as np
import torch
from torch.nn import functional as F


class InferenceCancelledError(RuntimeError):
    pass


class InferenceMemoryLimitError(RuntimeError):
    pass


@dataclass(frozen=True)
class MemmapImageDescriptor:
    path: Path
    width: int
    height: int
    channels: int
    dtype_name: str
    mode: str

    @property
    def shape(self):
        if self.channels == 1:
            return (self.height, self.width)
        return (self.height, self.width, self.channels)

    @property
    def dtype(self):
        return np.dtype(self.dtype_name)


class MemmapImageWriter:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self._descriptor: MemmapImageDescriptor | None = None
        self._array = None

    @property
    def descriptor(self) -> MemmapImageDescriptor | None:
        return self._descriptor

    def create(self, *, width: int, height: int, channels: int, dtype, mode: str) -> MemmapImageDescriptor:
        descriptor = MemmapImageDescriptor(
            path=self.path,
            width=int(width),
            height=int(height),
            channels=int(channels),
            dtype_name=np.dtype(dtype).name,
            mode=mode,
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._array = np.memmap(self.path, mode='w+', dtype=descriptor.dtype, shape=descriptor.shape)
        self._descriptor = descriptor
        return descriptor

    def write_region(self, x: int, y: int, tile):
        array = self._require_array()
        tile_height, tile_width = tile.shape[:2]
        if self._descriptor.channels == 1:
            array[y:y + tile_height, x:x + tile_width] = tile
            return

        if tile.ndim == 2:
            array[y:y + tile_height, x:x + tile_width, 0] = tile
            return

        channels = tile.shape[2]
        array[y:y + tile_height, x:x + tile_width, 0:channels] = tile

    def write_channel_region(self, x: int, y: int, channel_index: int, tile):
        array = self._require_array()
        tile_height, tile_width = tile.shape[:2]
        if self._descriptor.channels == 1 and channel_index == 0:
            array[y:y + tile_height, x:x + tile_width] = tile
            return
        array[y:y + tile_height, x:x + tile_width, channel_index] = tile

    def flush(self) -> None:
        if self._array is not None:
            self._array.flush()

    def resize_to(self, *, width: int, height: int) -> MemmapImageDescriptor:
        descriptor = self.require_descriptor()
        source = np.memmap(descriptor.path, mode='r', dtype=descriptor.dtype, shape=descriptor.shape)
        is_downscale = int(width) < descriptor.width or int(height) < descriptor.height
        interpolation = cv2.INTER_AREA if is_downscale else cv2.INTER_LANCZOS4
        resized = cv2.resize(np.asarray(source), (int(width), int(height)), interpolation=interpolation)
        replacement_path = descriptor.path.with_name(f'{descriptor.path.stem}-resized{descriptor.path.suffix}')
        replacement = np.memmap(
            replacement_path,
            mode='w+',
            dtype=descriptor.dtype,
            shape=(int(height), int(width)) if descriptor.channels == 1 else (int(height), int(width), descriptor.channels),
        )
        replacement[...] = resized
        replacement.flush()
        self._array = replacement
        self._descriptor = MemmapImageDescriptor(
            path=replacement_path,
            width=int(width),
            height=int(height),
            channels=descriptor.channels,
            dtype_name=descriptor.dtype_name,
            mode=descriptor.mode,
        )
        descriptor.path.unlink(missing_ok=True)
        self.path = replacement_path
        return self._descriptor

    def require_descriptor(self) -> MemmapImageDescriptor:
        if self._descriptor is None:
            raise RuntimeError('Memmap output was not initialized.')
        return self._descriptor

    def _require_array(self):
        if self._array is None:
            raise RuntimeError('Memmap output was not initialized.')
        return self._array


class ArrayImageWriter:
    def __init__(self):
        self._array = None
        self._mode = 'RGB'

    def create(self, *, width: int, height: int, channels: int, dtype, mode: str):
        shape = (int(height), int(width)) if channels == 1 else (int(height), int(width), int(channels))
        self._array = np.zeros(shape, dtype=dtype)
        self._mode = mode
        return None

    def write_region(self, x: int, y: int, tile):
        tile_height, tile_width = tile.shape[:2]
        if self._array.ndim == 2:
            self._array[y:y + tile_height, x:x + tile_width] = tile
            return
        if tile.ndim == 2:
            self._array[y:y + tile_height, x:x + tile_width, 0] = tile
            return
        self._array[y:y + tile_height, x:x + tile_width, 0:tile.shape[2]] = tile

    def write_channel_region(self, x: int, y: int, channel_index: int, tile):
        tile_height, tile_width = tile.shape[:2]
        if self._array.ndim == 2 and channel_index == 0:
            self._array[y:y + tile_height, x:x + tile_width] = tile
            return
        self._array[y:y + tile_height, x:x + tile_width, channel_index] = tile

    def flush(self) -> None:
        return None

    def resize_to(self, *, width: int, height: int):
        current_h, current_w = self._array.shape[:2]
        is_downscale = int(width) < current_w or int(height) < current_h
        interpolation = cv2.INTER_AREA if is_downscale else cv2.INTER_LANCZOS4
        self._array = cv2.resize(self._array, (int(width), int(height)), interpolation=interpolation)
        return None

    def get_image(self):
        return self._array


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]
RSSCallback = Callable[[], None]


class RealESRGANer:
    def __init__(
        self,
        *,
        scale,
        model_path,
        model,
        tile=0,
        tile_pad=10,
        pre_pad=0,
        half=False,
        device=None,
    ):
        self.scale = scale
        self.tile_size = tile
        self.tile_pad = tile_pad
        self.pre_pad = pre_pad
        self.half = half
        self.device = device or torch.device('cpu')

        loadnet = torch.load(model_path, map_location=torch.device('cpu'), weights_only=True)
        keyname = 'params_ema' if 'params_ema' in loadnet else 'params'
        model.load_state_dict(loadnet[keyname], strict=True)
        model.eval()
        self.model = model.to(self.device)
        if self.half:
            self.model = self.model.half()

    @torch.inference_mode()
    def enhance(self, img, *, outscale=None, alpha_upsampler='realesrgan', progress_callback=None, cancel_callback=None):
        writer = ArrayImageWriter()
        self.enhance_streaming(
            img,
            tile_size=self.tile_size,
            outscale=outscale,
            writer=writer,
            alpha_upsampler=alpha_upsampler,
            progress_callback=progress_callback,
            cancel_callback=cancel_callback,
            rss_callback=None,
        )
        return writer.get_image(), _determine_mode(img)

    @torch.inference_mode()
    def enhance_streaming(
        self,
        img,
        *,
        tile_size,
        outscale,
        writer,
        alpha_upsampler='realesrgan',
        progress_callback: ProgressCallback | None = None,
        cancel_callback: CancelCallback | None = None,
        rss_callback: RSSCallback | None = None,
    ):
        height_input, width_input = img.shape[0:2]
        img = img.astype(np.float32)
        max_range = 65535 if np.max(img) > 256 else 255
        img = img / max_range

        if len(img.shape) == 2:
            img_mode = 'L'
            rgb_img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
            alpha_plane = None
            channels = 1
        elif img.shape[2] == 4:
            img_mode = 'RGBA'
            alpha_plane = img[:, :, 3]
            rgb_img = cv2.cvtColor(img[:, :, 0:3], cv2.COLOR_BGR2RGB)
            channels = 4
        else:
            img_mode = 'RGB'
            rgb_img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
            alpha_plane = None
            channels = 3

        if cancel_callback and cancel_callback():
            raise InferenceCancelledError('Inference cancelled.')

        effective_tile = max(1, int(tile_size or min(rgb_img.shape[0], rgb_img.shape[1], 64)))
        total_tiles = _count_tiles(rgb_img.shape[1], rgb_img.shape[0], effective_tile)
        alpha_uses_model = img_mode == 'RGBA' and alpha_upsampler == 'realesrgan'
        if alpha_uses_model:
            total_tiles *= 2

        writer.create(
            width=width_input * self.scale,
            height=height_input * self.scale,
            channels=channels,
            dtype=np.uint16 if max_range == 65535 else np.uint8,
            mode=img_mode,
        )

        progress_done = 0
        progress_done = self._run_tiles(
            rgb_img,
            tile_size=effective_tile,
            writer=writer,
            progress_done=progress_done,
            progress_total=total_tiles,
            progress_callback=progress_callback,
            cancel_callback=cancel_callback,
            rss_callback=rss_callback,
            max_range=max_range,
            grayscale_output=(img_mode == 'L'),
        )

        if img_mode == 'RGBA':
            if cancel_callback and cancel_callback():
                raise InferenceCancelledError('Inference cancelled.')
            if alpha_uses_model:
                progress_done = self._run_tiles(
                    alpha_plane,
                    tile_size=effective_tile,
                    writer=writer,
                    progress_done=progress_done,
                    progress_total=total_tiles,
                    progress_callback=progress_callback,
                    cancel_callback=cancel_callback,
                    rss_callback=rss_callback,
                    max_range=max_range,
                    grayscale_source=True,
                    grayscale_output=True,
                    channel_index=3,
                )
            else:
                output_alpha = cv2.resize(
                    alpha_plane,
                    (width_input * self.scale, height_input * self.scale),
                    interpolation=cv2.INTER_LINEAR,
                )
                output_alpha = _normalize_output_dtype(output_alpha, max_range=max_range)
                writer.write_channel_region(0, 0, 3, output_alpha)
                progress_done = total_tiles
                if progress_callback and total_tiles > 0:
                    progress_callback(progress_done, total_tiles, 'running')

        writer.flush()

        if outscale is not None and outscale != float(self.scale):
            writer.resize_to(
                width=int(width_input * outscale),
                height=int(height_input * outscale),
            )
            writer.flush()

        if progress_callback and total_tiles > 0:
            progress_callback(total_tiles, total_tiles, 'running')

        descriptor = getattr(writer, 'descriptor', None)
        return descriptor, img_mode

    def _run_tiles(
        self,
        source,
        *,
        tile_size: int,
        writer,
        progress_done: int,
        progress_total: int,
        progress_callback: ProgressCallback | None,
        cancel_callback: CancelCallback | None,
        rss_callback: RSSCallback | None,
        max_range: int,
        grayscale_source: bool = False,
        grayscale_output: bool = False,
        channel_index: int | None = None,
    ) -> int:
        height = source.shape[0]
        width = source.shape[1]
        tiles_x = math.ceil(width / tile_size)
        tiles_y = math.ceil(height / tile_size)

        for y in range(tiles_y):
            for x in range(tiles_x):
                if cancel_callback and cancel_callback():
                    raise InferenceCancelledError('Inference cancelled.')
                if rss_callback:
                    rss_callback()

                ofs_x = x * tile_size
                ofs_y = y * tile_size
                input_end_x = min(ofs_x + tile_size, width)
                input_end_y = min(ofs_y + tile_size, height)
                tile = self._infer_tile(
                    source,
                    start_x=ofs_x,
                    start_y=ofs_y,
                    end_x=input_end_x,
                    end_y=input_end_y,
                    grayscale_source=grayscale_source,
                )

                normalized_tile = _normalize_output_dtype(tile, max_range=max_range)
                if grayscale_output:
                    if normalized_tile.ndim == 3:
                        normalized_tile = cv2.cvtColor(normalized_tile, cv2.COLOR_RGB2GRAY)
                    if channel_index is None:
                        writer.write_region(ofs_x * self.scale, ofs_y * self.scale, normalized_tile)
                    else:
                        writer.write_channel_region(ofs_x * self.scale, ofs_y * self.scale, channel_index, normalized_tile)
                elif channel_index is None:
                    writer.write_region(ofs_x * self.scale, ofs_y * self.scale, normalized_tile)
                else:
                    writer.write_channel_region(ofs_x * self.scale, ofs_y * self.scale, channel_index, normalized_tile)

                progress_done += 1
                if progress_callback and progress_total > 0:
                    progress_callback(progress_done, progress_total, 'running')
                if rss_callback:
                    rss_callback()

        return progress_done

    def _infer_tile(self, source, *, start_x: int, start_y: int, end_x: int, end_y: int, grayscale_source: bool = False):
        height = source.shape[0]
        width = source.shape[1]
        pad_start_x = max(start_x - self.tile_pad, 0)
        pad_end_x = min(end_x + self.tile_pad, width)
        pad_start_y = max(start_y - self.tile_pad, 0)
        pad_end_y = min(end_y + self.tile_pad, height)

        tile = source[pad_start_y:pad_end_y, pad_start_x:pad_end_x]
        if grayscale_source:
            tile = np.repeat(tile[:, :, None], 3, axis=2)

        input_tile = torch.from_numpy(np.transpose(tile, (2, 0, 1))).float().unsqueeze(0).to(self.device)
        if self.half:
            input_tile = input_tile.half()

        if self.pre_pad:
            input_tile = F.pad(input_tile, (0, self.pre_pad, 0, self.pre_pad), 'reflect')

        # Match the official Real-ESRGAN preprocessing path: only x2 and x1
        # models require mod padding before inference.
        mod_scale = 2 if self.scale == 2 else (4 if self.scale == 1 else None)
        mod_pad_h = 0
        mod_pad_w = 0
        if mod_scale is not None:
            _, _, tile_height, tile_width = input_tile.shape
            if tile_height % mod_scale != 0:
                mod_pad_h = mod_scale - tile_height % mod_scale
            if tile_width % mod_scale != 0:
                mod_pad_w = mod_scale - tile_width % mod_scale
            if mod_pad_h or mod_pad_w:
                input_tile = F.pad(input_tile, (0, mod_pad_w, 0, mod_pad_h), 'reflect')

        output_tile = self.model(input_tile)

        if mod_scale is not None and (mod_pad_h or mod_pad_w):
            _, _, out_h, out_w = output_tile.shape
            output_tile = output_tile[:, :, 0:out_h - mod_pad_h * self.scale, 0:out_w - mod_pad_w * self.scale]
        if self.pre_pad:
            _, _, out_h, out_w = output_tile.shape
            output_tile = output_tile[:, :, 0:out_h - self.pre_pad * self.scale, 0:out_w - self.pre_pad * self.scale]

        output_tile = output_tile.squeeze(0).float().cpu().clamp_(0, 1).numpy()
        output_tile = np.transpose(output_tile, (1, 2, 0))

        output_start_x = (start_x - pad_start_x) * self.scale
        output_end_x = output_start_x + (end_x - start_x) * self.scale
        output_start_y = (start_y - pad_start_y) * self.scale
        output_end_y = output_start_y + (end_y - start_y) * self.scale
        tile = output_tile[output_start_y:output_end_y, output_start_x:output_end_x]

        del input_tile
        del output_tile
        return tile


def _determine_mode(img) -> str:
    if len(img.shape) == 2:
        return 'L'
    if img.shape[2] == 4:
        return 'RGBA'
    return 'RGB'


def _count_tiles(width: int, height: int, tile_size: int) -> int:
    return math.ceil(width / tile_size) * math.ceil(height / tile_size)


def _normalize_output_dtype(tile, *, max_range: int):
    if max_range == 65535:
        return (tile * 65535.0).round().astype(np.uint16)
    return (tile * 255.0).round().astype(np.uint8)
