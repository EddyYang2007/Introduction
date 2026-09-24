# Core snapshot boundary

Included: user-authored optical-flow feature extraction, display/front-end processing, browser UI source, and a synthetic contract smoke test. Any local calibration root has been replaced with a repository-relative fixture path.

Excluded: advisor hardware design, live camera captures, MCAP/NPZ, trained model weights, calibration images and force labels. Without those excluded artifacts, the copied live inference path cannot yield force estimates. The synthetic test proves only deterministic software contracts.

