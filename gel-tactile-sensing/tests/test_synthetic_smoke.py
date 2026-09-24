from pathlib import Path
import unittest
import cv2
import numpy as np
from tactile_frontend import prepare_frame, _contact_centroid, field_points, pressure_grid_points

class SyntheticSmoke(unittest.TestCase):
    def test_synthetic_frame_contract(self):
        h, w = 480, 640
        y, x = np.mgrid[:h, :w]
        base = np.full((h,w,3), 96, np.uint8)
        cur = base.copy()
        blob = np.exp(-(((x-320)/55)**2 + ((y-240)/42)**2)).astype(np.float32)
        cur[:,:,1] = np.clip(cur[:,:,1].astype(float) + blob*55, 0, 255).astype(np.uint8)
        prepared = prepare_frame(cur)
        self.assertEqual(prepared.shape, (256,400,3))
        flow = np.zeros((256,400,2), np.float32)
        flow[120:136,190:210,0] = 1.5
        center = _contact_centroid(flow)
        self.assertTrue(90 <= center[0] <= 315)
        self.assertTrue(24 <= center[1] <= 244)
        points = field_points(flow, 1.0)
        self.assertTrue(points)
        grid = pressure_grid_points(flow, 0.0, True, force_estimate_available=False)
        self.assertEqual(grid['unit'], 'relative deformation')
        self.assertFalse(grid['force_estimate_available'])

if __name__ == '__main__': unittest.main()

