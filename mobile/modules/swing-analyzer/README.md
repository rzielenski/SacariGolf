# SwingAnalyzer — Native Vision-framework module

Wraps Apple's `VNDetectHumanBodyPoseRequest` and `VNDetectTrajectoriesRequest` so the JS app can analyze a recorded swing video and get back real joint positions per frame + a real clubhead trajectory.

## Architecture

```
JS (Range Session)
  ↓ analyzeSwing(videoUri, club, ...)
mobile/lib/rangeSession.ts
  ↓ if isAvailable() → call native
mobile/modules/swing-analyzer/src/index.ts (TypeScript bridge)
  ↓ requireOptionalNativeModule('SwingAnalyzer')
mobile/modules/swing-analyzer/ios/SwingAnalyzerModule.swift (Expo module)
  ↓ AVAssetReader iterates video frames
  ↓ VNDetectHumanBodyPoseRequest per frame  → joint positions
  ↓ VNDetectTrajectoriesRequest sequence    → clubhead arc
  ↓ resolve promise with { poseFrames, trajectories }
```

The JS side falls back to the deterministic template analyzer if the native module isn't linked (Expo Go, Android, or before you run `prebuild`). Falls back ALSO if the native call throws — you'll see a red "BETA · TEMPLATE ANALYSIS" banner on the analyze screen telling you which path was used.

## To make it actually run

The native module needs to be **compiled into the iOS app binary**. You can't test this in Expo Go.

### 1. Prebuild the iOS project

From the `mobile/` directory:

```bash
npx expo prebuild --platform ios --clean
```

The `--clean` flag regenerates `ios/` from scratch — important after adding a new local native module. Re-run this any time you change `expo-module.config.json` or add new Swift files.

### 2. Install pods

```bash
cd ios && pod install && cd ..
```

(If `expo prebuild` did this automatically you'll see "Installing CocoaPods" in its output and can skip this step.)

### 3. Build and install on a physical iPhone

**Option A — local Xcode build (fastest iteration):**

```bash
npx expo run:ios --device
```

Pick your connected iPhone. First build takes ~5-10 min; subsequent rebuilds ~30s-2min.

**Option B — EAS dev build (no Xcode needed):**

```bash
eas build --profile development --platform ios
```

Then download the `.ipa` from EAS and install via TestFlight or sideload.

### 4. Verify it's working

Record a swing in Range Session. On the analyze screen you should see:

- A **green** "VISION ANALYSIS" banner at the top of the screen (not red)
- Skeleton dots that actually overlap with the golfer's body in the video
- Trace dots that follow the actual clubhead path

If you see a **red** "BETA · TEMPLATE ANALYSIS" banner, the native module isn't loaded or threw an error. Check the dev-tools console for `[SwingAnalyzer] native analysis failed` — that has the actual error message.

## What the analyzer outputs

| Field | Type | Notes |
|---|---|---|
| `poseFrames` | array of `{ time, headTop?, leftShoulder?, ... }` | Each frame has whatever joints Vision detected with ≥0.30 confidence. Joints below threshold are OMITTED, not zero-padded. |
| `trajectories` | array of `{ uuid, points, equationCoefficients, confidence }` | Every ballistic motion path Vision identified. The JS side picks the longest × highest-confidence one as the clubhead. |
| `duration` | number | Seconds |
| `frameCount` | number | Frames analyzed |

Coordinates are normalized `0-1` in the video's frame, with `y=0` at the **TOP** of the frame (we flip Vision's bottom-origin coords on the Swift side to match screen-coords).

## What it does NOT measure

- **Clubhead speed (mph), ball speed, smash factor, spin, carry yards** — these need a launch monitor or precise scale calibration (e.g., a known-size marker in the frame). Without that, the speed-related numbers in the UI are still derived from your handicap + club selection.
- **Body angles in degrees** (hip turn, shoulder turn) — the geometry exists in the joint positions but computing meaningful degree values requires knowing the camera angle. Doable as a v2 pass.

The analyze screen labels these as "BETA / estimated" in the green banner so the user isn't misled.

## Performance

- ~10-30ms per frame on Apple Neural Engine (iPhone 12+)
- A 5-second 30fps video: ~150 frames × 20ms = ~3 seconds analysis time
- A 5-second 240fps slo-mo: ~1200 frames × 20ms = ~24 seconds
- Wrapped in a Task on the Swift side so the JS side just awaits a promise

## Iteration

If something goes wrong, the most likely failure modes are:

1. **Swift compile errors after prebuild** — bring me the Xcode error and I'll fix the code.
2. **`requireOptionalNativeModule` returns null** at runtime — module's `expo-module.config.json` not being picked up. Check that `mobile/modules/swing-analyzer/expo-module.config.json` exists and reruns `prebuild --clean`.
3. **AVAssetReader fails on the video file** — usually a permissions issue or a malformed file from a third-party recorder. Check the rejection message.
4. **Pose detection returns nothing** — the golfer might be too small in frame, or low light. Vision works best with the subject filling at least 25% of the frame height.
