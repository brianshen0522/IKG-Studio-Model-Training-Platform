"""GPU telemetry sampling for the worker heartbeat.

`WorkerRegistry` used to read VRAM straight from `torch.cuda.mem_get_info()` on
every heartbeat (15s). That gives memory but *not* SM utilization — torch has no
API for it — and a single instantaneous reading taken every 15s is a misleading
number to put on a dashboard: a training run's utilization swings between batches,
so whatever the heartbeat happens to catch is noise.

So sampling is decoupled from reporting. A daemon thread polls NVML every
`interval_s` (default 2s) into a bounded ring buffer; the heartbeat then reports
the newest reading plus the min/avg/max over the window and the raw samples (for a
dashboard sparkline). Everything published is a real measurement — no synthesized
or interpolated values.

NVML comes from `nvidia-ml-py`, already present as an Ultralytics dependency, and
is independent of the torch build: a CPU-only torch wheel on a host with an NVIDIA
driver still reports full telemetry. Three-tier degradation:

  1. NVML      — memory + utilization + temperature + power (what we want)
  2. torch     — memory only, utilization reported as None (CPU-wheel, no driver)
  3. nothing   — empty device list; the UI says so rather than inventing numbers

`None` is used throughout for "not measurable here", and is never conflated with 0.
"""
import threading
import time
from collections import deque
from typing import Any

from . import log

# Window of history published with each heartbeat. 60 samples * 2s = ~2 minutes,
# enough for a readable sparkline while keeping the jsonb payload small.
WINDOW_SAMPLES = 60
SAMPLE_INTERVAL_S = 2


def _nvml() -> Any:
    """Import and initialize NVML, or return None if unavailable."""
    try:
        import pynvml

        pynvml.nvmlInit()
        return pynvml
    except Exception:
        return None


def _decode(value) -> str:
    """NVML returns bytes on older bindings, str on newer ones."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return str(value)


class GpuProbe:
    """Background NVML sampler with a bounded per-device history ring."""

    def __init__(self, interval_s: int = SAMPLE_INTERVAL_S, window: int = WINDOW_SAMPLES) -> None:
        self.interval_s = max(1, interval_s)
        self.window = max(2, window)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        # gpu index -> {"static": {...}, "samples": deque[dict]}
        self._devices: dict[int, dict] = {}
        # Opaque module handle: the binding is resolved at runtime and is absent on
        # hosts without an NVIDIA driver, so it is deliberately untyped here.
        self._nvml: Any = None
        self._source = "none"

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        self._nvml = _nvml()
        if self._nvml is not None:
            self._source = "nvml"
        elif self._torch_device_count() > 0:
            self._source = "torch"
        else:
            self._source = "none"
            log.info("gpu probe found no GPUs; reporting CPU only")
            return
        # Prime the buffer so the first heartbeat after start already has a reading
        # instead of an empty device list.
        self._sample_once()
        self._thread = threading.Thread(target=self._run, name="gpu-probe", daemon=True)
        self._thread.start()
        log.info("gpu probe started", source=self._source, interval_s=self.interval_s)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._nvml is not None:
            try:
                self._nvml.nvmlShutdown()
            except Exception:
                pass

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            try:
                self._sample_once()
            except Exception as e:  # noqa: BLE001
                log.warn("gpu sample failed", error=str(e)[:200])

    # ── sampling ─────────────────────────────────────────────────────────────

    def _torch_device_count(self) -> int:
        try:
            import torch

            return torch.cuda.device_count() if torch.cuda.is_available() else 0
        except Exception:
            return 0

    def _sample_once(self) -> None:
        readings = self._sample_nvml() if self._nvml is not None else self._sample_torch()
        now = time.time()
        with self._lock:
            for r in readings:
                idx = r["index"]
                entry = self._devices.get(idx)
                if entry is None:
                    entry = {"static": {}, "samples": deque(maxlen=self.window)}
                    self._devices[idx] = entry
                entry["static"] = {
                    "index": idx,
                    "uuid": r.get("uuid"),
                    "name": r.get("name"),
                    "memory_total_mb": r.get("memory_total_mb"),
                    "power_limit_w": r.get("power_limit_w"),
                }
                entry["samples"].append({
                    "at": now,
                    "utilization_pct": r.get("utilization_pct"),
                    "memory_used_mb": r.get("memory_used_mb"),
                    "memory_utilization_pct": r.get("memory_utilization_pct"),
                    "temperature_c": r.get("temperature_c"),
                    "power_w": r.get("power_w"),
                })

    def _sample_nvml(self) -> list[dict]:
        nv = self._nvml
        if nv is None:
            return []
        out: list[dict] = []
        for i in range(nv.nvmlDeviceGetCount()):
            h = nv.nvmlDeviceGetHandleByIndex(i)
            row: dict = {"index": i}
            # Each metric is independently optional: consumer cards report no power
            # limit, some virtualized GPUs report no utilization. One missing metric
            # must not drop the whole device.
            try:
                row["uuid"] = _decode(nv.nvmlDeviceGetUUID(h))
            except Exception:
                row["uuid"] = None
            try:
                row["name"] = _decode(nv.nvmlDeviceGetName(h))
            except Exception:
                row["name"] = f"GPU {i}"
            try:
                mem = nv.nvmlDeviceGetMemoryInfo(h)
                row["memory_total_mb"] = round(mem.total / (1024 * 1024))
                row["memory_used_mb"] = round(mem.used / (1024 * 1024))
            except Exception:
                row["memory_total_mb"] = row["memory_used_mb"] = None
            try:
                util = nv.nvmlDeviceGetUtilizationRates(h)
                row["utilization_pct"] = int(util.gpu)
                # NVML's memory utilization is bandwidth busy-time, not used/total.
                row["memory_utilization_pct"] = int(util.memory)
            except Exception:
                row["utilization_pct"] = row["memory_utilization_pct"] = None
            try:
                row["temperature_c"] = int(nv.nvmlDeviceGetTemperature(h, nv.NVML_TEMPERATURE_GPU))
            except Exception:
                row["temperature_c"] = None
            try:
                row["power_w"] = round(nv.nvmlDeviceGetPowerUsage(h) / 1000, 1)
            except Exception:
                row["power_w"] = None
            try:
                row["power_limit_w"] = round(nv.nvmlDeviceGetEnforcedPowerLimit(h) / 1000, 1)
            except Exception:
                row["power_limit_w"] = None
            out.append(row)
        return out

    def _sample_torch(self) -> list[dict]:
        """Memory-only fallback. utilization stays None so the UI can say
        "not available" rather than showing a plausible-looking 0%."""
        try:
            import torch
        except Exception:
            return []
        out: list[dict] = []
        for i in range(torch.cuda.device_count()):
            try:
                free_b, total_b = torch.cuda.mem_get_info(i)
                out.append({
                    "index": i,
                    "uuid": None,
                    "name": torch.cuda.get_device_name(i),
                    "memory_total_mb": round(total_b / (1024 * 1024)),
                    "memory_used_mb": round((total_b - free_b) / (1024 * 1024)),
                    "utilization_pct": None,
                    "memory_utilization_pct": None,
                    "temperature_c": None,
                    "power_w": None,
                    "power_limit_w": None,
                })
            except Exception:
                continue
        return out

    # ── reporting ────────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """Current per-device state + window aggregates, for the heartbeat payload.

        Shape is the `capabilities` jsonb the API and web UI consume. `devices[].index`
        stays the Ultralytics `device=` index, so it remains compatible with the
        existing DevicePicker.
        """
        with self._lock:
            devices = []
            for idx in sorted(self._devices):
                entry = self._devices[idx]
                samples = list(entry["samples"])
                static = entry["static"]
                latest = samples[-1] if samples else {}
                utils = [s["utilization_pct"] for s in samples if s.get("utilization_pct") is not None]
                mems = [s["memory_used_mb"] for s in samples if s.get("memory_used_mb") is not None]
                total_mb = static.get("memory_total_mb")
                used_mb = latest.get("memory_used_mb")
                devices.append({
                    "index": idx,
                    "uuid": static.get("uuid"),
                    "name": static.get("name"),
                    "memory_total_mb": total_mb,
                    "memory_used_mb": used_mb,
                    # Kept for backward compatibility with the existing DevicePicker,
                    # which reads total_memory_mb/used_memory_mb.
                    "total_memory_mb": total_mb,
                    "used_memory_mb": used_mb,
                    "memory_used_pct": (
                        round(used_mb / total_mb * 100, 1)
                        if total_mb and used_mb is not None and total_mb > 0
                        else None
                    ),
                    "utilization_pct": latest.get("utilization_pct"),
                    "memory_utilization_pct": latest.get("memory_utilization_pct"),
                    "temperature_c": latest.get("temperature_c"),
                    "power_w": latest.get("power_w"),
                    "power_limit_w": static.get("power_limit_w"),
                    "utilization_avg_pct": round(sum(utils) / len(utils), 1) if utils else None,
                    "utilization_max_pct": max(utils) if utils else None,
                    "memory_used_max_mb": max(mems) if mems else None,
                    "sample_count": len(samples),
                    "window_s": len(samples) * self.interval_s,
                    # Compact history for the sparkline: utilization only, oldest first.
                    "utilization_series": [s.get("utilization_pct") for s in samples],
                    "memory_series": [s.get("memory_used_mb") for s in samples],
                    "sampled_at": latest.get("at"),
                })
            return {
                "devices": devices,
                "gpu_telemetry": {
                    "source": self._source,
                    "interval_s": self.interval_s,
                    # Explicit so the UI can distinguish "no GPU on this host" from
                    # "GPU present but utilization unreadable".
                    "supports_utilization": self._source == "nvml",
                },
            }
