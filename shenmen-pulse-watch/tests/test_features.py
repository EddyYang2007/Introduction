import math
import unittest

from shenmen_pulse.features import extract_waveform_features


class FeatureExtractionTest(unittest.TestCase):
    def test_extracts_reasonable_rate_from_synthetic_wave(self):
        sample_rate = 250
        duration = 30
        timestamps = [index / sample_rate for index in range(sample_rate * duration)]
        values = []
        for t in timestamps:
            phase = (t % 1.0)
            pulse = math.exp(-((phase - 0.2) ** 2) / (2 * 0.035**2))
            values.append(0.5 + 0.08 * pulse + 0.005 * math.sin(2 * math.pi * 0.2 * t))

        features = extract_waveform_features(timestamps, values)

        self.assertGreater(features.beat_count, 20)
        self.assertAlmostEqual(features.pulse_rate_bpm, 60.0, delta=5.0)
        self.assertGreater(features.amplitude, 0.03)
        self.assertGreater(features.quality_score, 0.4)


if __name__ == "__main__":
    unittest.main()

