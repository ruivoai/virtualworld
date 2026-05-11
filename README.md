# Wireless Heatmap Planner

A browser-based tool for wireless engineers to:
- Upload a building floor plan.
- Infer wall regions from drawing contrast.
- Auto-place APs to satisfy a minimum RSSI target.
- Assign non-overlapping/reused channels using local-neighbor constraints.
- Render a coverage heatmap overlay.

## Run

Open `index.html` in a browser.

## Notes

This app uses a simplified propagation model (log-distance path loss + per-wall attenuation). It is intended for early-stage design assistance, not final certification.
