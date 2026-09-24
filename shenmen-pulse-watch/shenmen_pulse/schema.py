"""Data schema constants for Shenmen pulse quantification."""

from __future__ import annotations

from dataclasses import dataclass

WAVELENGTHS_NM = (525, 660, 940)
CHANNELS = ("center_ht7", "radial_ref", "ulnar_ref")
SIDES = ("left", "right")
PRESSURE_LEVELS_N = (0.3, 0.6, 0.9, 1.2, 1.5, 2.0)

RAW_COLUMNS = (
    "subject_id",
    "session_id",
    "side",
    "operator_id",
    "phase",
    "pressure_level_n",
    "timestamp_s",
    "wavelength_nm",
    "channel",
    "raw_ppg",
    "contact_force_n",
    "imu_x",
    "imu_y",
    "imu_z",
    "temperature_c",
    "quality_flag",
)


@dataclass(frozen=True)
class Sample:
    subject_id: str
    session_id: str
    side: str
    operator_id: str
    phase: str
    pressure_level_n: float
    timestamp_s: float
    wavelength_nm: int
    channel: str
    raw_ppg: float
    contact_force_n: float
    imu_x: float = 0.0
    imu_y: float = 0.0
    imu_z: float = 0.0
    temperature_c: float = 32.0
    quality_flag: str = ""

    def to_row(self) -> dict[str, str]:
        return {
            "subject_id": self.subject_id,
            "session_id": self.session_id,
            "side": self.side,
            "operator_id": self.operator_id,
            "phase": self.phase,
            "pressure_level_n": f"{self.pressure_level_n:.3f}",
            "timestamp_s": f"{self.timestamp_s:.4f}",
            "wavelength_nm": str(self.wavelength_nm),
            "channel": self.channel,
            "raw_ppg": f"{self.raw_ppg:.8f}",
            "contact_force_n": f"{self.contact_force_n:.5f}",
            "imu_x": f"{self.imu_x:.5f}",
            "imu_y": f"{self.imu_y:.5f}",
            "imu_z": f"{self.imu_z:.5f}",
            "temperature_c": f"{self.temperature_c:.3f}",
            "quality_flag": self.quality_flag,
        }


def validate_row(row: dict[str, str]) -> None:
    missing = [column for column in RAW_COLUMNS if column not in row]
    if missing:
        raise ValueError(f"Missing raw-data columns: {', '.join(missing)}")
    side = row["side"]
    if side not in SIDES:
        raise ValueError(f"Invalid side {side!r}; expected one of {SIDES}")
    channel = row["channel"]
    if channel not in CHANNELS:
        raise ValueError(f"Invalid channel {channel!r}; expected one of {CHANNELS}")
    wavelength = int(float(row["wavelength_nm"]))
    if wavelength not in WAVELENGTHS_NM:
        raise ValueError(f"Invalid wavelength {wavelength}; expected {WAVELENGTHS_NM}")

