import json
import tempfile
import unittest
from pathlib import Path

from shenmen_pulse.analyze import analyze_csv
from shenmen_pulse.io import write_samples
from shenmen_pulse.report import render_markdown
from shenmen_pulse.simulate import generate_samples


class WorkflowTest(unittest.TestCase):
    def test_simulate_analyze_report_workflow(self):
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "session.csv"
            samples = generate_samples(sweep_seconds=4.0, best_seconds=6.0, sample_rate_hz=100)
            write_samples(csv_path, samples)

            report = analyze_csv(csv_path)
            markdown = render_markdown(report)
            payload = json.dumps(report, ensure_ascii=False)

        self.assertIn("best_pressure_n", report)
        self.assertGreater(report["best_pressure_n"], 0.0)
        self.assertIn("center_to_reference_amplitude_ratio", payload)
        self.assertIn("does not provide clinical diagnosis", markdown)


if __name__ == "__main__":
    unittest.main()

