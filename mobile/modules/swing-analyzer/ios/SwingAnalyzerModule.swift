/**
 * SwingAnalyzerModule.swift
 *
 * Native iOS module that takes a recorded swing video and returns:
 *   • Per-frame body-pose joint positions (from VNDetectHumanBodyPoseRequest)
 *   • Detected clubhead trajectory points (from VNDetectTrajectoriesRequest)
 *
 * All Vision-framework work runs on-device on the Apple Neural Engine.
 * Returns plain JSON-serializable dictionaries to React Native so the JS
 * side can render the skeleton + tracer without any further ML knowledge.
 *
 * Coordinate system: outputs are normalized 0-1 in the video's coordinate
 * space (matching what the JS UI consumes). y is flipped from Vision's
 * native (which has y=0 at the bottom) to screen-coords (y=0 at the top).
 *
 * Performance note: a typical 5-15 second swing video has 150-3600 frames.
 * Vision requests on the Neural Engine take ~10-30ms per frame, so total
 * analysis time is roughly 1.5-30s. Wraps work in a Task so JS can show a
 * progress UI while it runs.
 */

import ExpoModulesCore
import Vision
import AVFoundation
import UIKit

public class SwingAnalyzerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SwingAnalyzer")

    AsyncFunction("isAvailable") { () -> [String: Any] in
      // VNDetectTrajectoriesRequest is iOS 14+ only.
      if #available(iOS 14.0, *) {
        return [
          "available": true,
          "iosVersion": UIDevice.current.systemVersion,
        ]
      }
      return [
        "available": false,
        "iosVersion": UIDevice.current.systemVersion,
        "reason": "Requires iOS 14.0 or later",
      ]
    }

    AsyncFunction("analyzeVideo") { (videoUri: String, promise: Promise) in
      guard #available(iOS 14.0, *) else {
        promise.reject("UNSUPPORTED", "Vision framework swing analysis requires iOS 14+")
        return
      }
      Task {
        do {
          let analyzer = SwingAnalyzer()
          let result = try await analyzer.analyze(uri: videoUri)
          promise.resolve(result)
        } catch let err {
          promise.reject("ANALYZE_FAILED", err.localizedDescription)
        }
      }
    }
  }
}

// MARK: - Analyzer

@available(iOS 14.0, *)
final class SwingAnalyzer {
  /// Process a video file end-to-end. Returns a dictionary shaped for the
  /// JS bridge consumer (see swing-analyzer/src/index.ts for the typed form).
  func analyze(uri: String) async throws -> [String: Any] {
    let url = try Self.parseURL(uri)
    let asset = AVURLAsset(url: url)

    // ── Asset metadata ─────────────────────────────────────────────────
    let duration = try await asset.load(.duration).seconds
    let videoTracks = try await asset.loadTracks(withMediaType: .video)
    guard let videoTrack = videoTracks.first else {
      throw NSError(domain: "SwingAnalyzer", code: 100, userInfo: [
        NSLocalizedDescriptionKey: "No video track found in file"
      ])
    }

    // ── Set up frame reader ────────────────────────────────────────────
    // Pull frames as BGRA pixel buffers — both Vision requests accept this
    // format directly so we avoid any colorspace conversion overhead.
    let reader = try AVAssetReader(asset: asset)
    let outputSettings: [String: Any] = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
    let output = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else {
      throw NSError(domain: "SwingAnalyzer", code: 101, userInfo: [
        NSLocalizedDescriptionKey: "Failed to start AVAssetReader: \(reader.error?.localizedDescription ?? "unknown")"
      ])
    }

    // ── Vision requests ────────────────────────────────────────────────
    // Body pose: stateless, run on each frame independently.
    let bodyPoseRequest = VNDetectHumanBodyPoseRequest()

    // Trajectory: stateful — we feed it frames in sequence and it tracks
    // ballistic objects across them. Single shared completion handler
    // collects all trajectories we see (the clubhead arc most prominently).
    var trajectoryObservations: [[String: Any]] = []
    let trajectoryRequest = VNDetectTrajectoriesRequest(
      frameAnalysisSpacing: .zero,
      trajectoryLength: 5
    ) { request, _ in
      guard let observations = request.results as? [VNTrajectoryObservation] else { return }
      for obs in observations {
        let points = obs.detectedPoints.map { point -> [String: Double] in
          // Vision uses y-up; flip to y-down to match screen-coords.
          return [
            "x": Double(point.location.x),
            "y": Double(1.0 - point.location.y),
          ]
        }
        // equationCoefficients is the parabolic fit (a + bx + cx²).
        let coefficients = obs.equationCoefficients
        trajectoryObservations.append([
          "uuid": obs.uuid.uuidString,
          "points": points,
          "equationCoefficients": [
            "a": Double(coefficients.a),
            "b": Double(coefficients.b),
            "c": Double(coefficients.c),
          ],
          "confidence": Double(obs.confidence),
        ])
      }
    }
    let trajectorySequenceHandler = VNSequenceRequestHandler()

    // ── Iterate frames ─────────────────────────────────────────────────
    var poseFrames: [[String: Any]] = []
    var frameIndex = 0

    while reader.status == .reading, let sampleBuffer = output.copyNextSampleBuffer() {
      defer { frameIndex += 1 }

      guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
      let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds

      // Body pose — run on this single frame.
      let bodyHandler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
      do {
        try bodyHandler.perform([bodyPoseRequest])
        if let observation = bodyPoseRequest.results?.first as? VNHumanBodyPoseObservation {
          if let frame = Self.extractPose(from: observation, time: presentationTime) {
            poseFrames.append(frame)
          }
        }
      } catch {
        // Per-frame failure is fine — Vision occasionally throws on noisy
        // frames; we just skip and continue.
      }

      // Trajectory — feed into the sequence handler so it can correlate
      // across frames and report detected ballistic paths.
      do {
        try trajectorySequenceHandler.perform([trajectoryRequest], on: pixelBuffer, orientation: .up)
      } catch {
        // Same — keep going on per-frame errors.
      }
    }

    if reader.status == .failed {
      throw NSError(domain: "SwingAnalyzer", code: 102, userInfo: [
        NSLocalizedDescriptionKey: "AVAssetReader failed: \(reader.error?.localizedDescription ?? "unknown")"
      ])
    }

    return [
      "duration": duration,
      "frameCount": frameIndex,
      "poseFrames": poseFrames,
      "trajectories": trajectoryObservations,
    ]
  }

  // MARK: - Helpers

  private static func parseURL(_ uri: String) throws -> URL {
    if let url = URL(string: uri), url.isFileURL {
      return url
    }
    if uri.hasPrefix("file://") {
      let stripped = String(uri.dropFirst("file://".count))
      return URL(fileURLWithPath: stripped)
    }
    if uri.hasPrefix("/") {
      return URL(fileURLWithPath: uri)
    }
    throw NSError(domain: "SwingAnalyzer", code: 103, userInfo: [
      NSLocalizedDescriptionKey: "Unsupported video URI: \(uri). Expected a file:// URL or absolute path."
    ])
  }

  /// Extract the joints we care about from a Vision pose observation. Returns
  /// nil if the observation has too few high-confidence joints to be useful.
  @available(iOS 14.0, *)
  private static func extractPose(
    from observation: VNHumanBodyPoseObservation,
    time: Double
  ) -> [String: Any]? {
    // Vision returns ~19 named joints. We map them to the 14 the JS UI
    // expects. Joints below the confidence threshold are omitted rather
    // than included with low-confidence positions.
    let MIN_CONFIDENCE: Float = 0.30

    func point(_ name: VNHumanBodyPoseObservation.JointName) -> [String: Double]? {
      guard let p = try? observation.recognizedPoint(name) else { return nil }
      guard p.confidence >= MIN_CONFIDENCE else { return nil }
      // Vision uses normalized 0-1 coords with y growing UP from the
      // bottom-left. Flip y to match screen coords (y growing DOWN).
      return ["x": Double(p.location.x), "y": Double(1.0 - p.location.y)]
    }

    // Map Vision's joint names → our schema names. Note that Vision has
    // separate left/right ear/eye points; we approximate "headTop" with
    // the average of the eyes (or nose) and "headBottom" with the neck
    // joint when both exist.
    let nose = point(.nose)
    let neck = point(.neck)
    let leftEye = point(.leftEye)
    let rightEye = point(.rightEye)

    // headTop: midpoint of eyes if both present, else nose
    var headTop: [String: Double]? = nil
    if let le = leftEye, let re = rightEye {
      headTop = [
        "x": ((le["x"] ?? 0) + (re["x"] ?? 0)) / 2,
        "y": ((le["y"] ?? 0) + (re["y"] ?? 0)) / 2,
      ]
    } else if let n = nose {
      headTop = n
    }

    var frame: [String: Any] = ["time": time]
    if let v = headTop                                  { frame["headTop"] = v }
    if let v = neck ?? nose                              { frame["headBottom"] = v }
    if let v = point(.leftShoulder)                      { frame["leftShoulder"] = v }
    if let v = point(.rightShoulder)                     { frame["rightShoulder"] = v }
    if let v = point(.leftElbow)                         { frame["leftElbow"] = v }
    if let v = point(.rightElbow)                        { frame["rightElbow"] = v }
    if let v = point(.leftWrist)                         { frame["leftWrist"] = v }
    if let v = point(.rightWrist)                        { frame["rightWrist"] = v }
    if let v = point(.leftHip)                           { frame["leftHip"] = v }
    if let v = point(.rightHip)                          { frame["rightHip"] = v }
    if let v = point(.leftKnee)                          { frame["leftKnee"] = v }
    if let v = point(.rightKnee)                         { frame["rightKnee"] = v }
    if let v = point(.leftAnkle)                         { frame["leftFoot"] = v }
    if let v = point(.rightAnkle)                        { frame["rightFoot"] = v }

    // If we got fewer than ~8 high-confidence joints, the detection is
    // probably mostly garbage — skip the frame.
    let jointCount = frame.keys.filter { $0 != "time" }.count
    if jointCount < 8 { return nil }
    return frame
  }
}
