//
//  MotionMonitor.swift
//  SacariGolfWatch
//
//  CoreMotion wrapper that emits a "high-rotation event" whenever the
//  wrist swings through what looks like a golf-swing arc.
//
//  Detection rule (kept simple on purpose):
//    • Sample deviceMotion at 100Hz (gyro update interval = 0.01s).
//    • Compute combined angular speed |ω| = sqrt(ωx² + ωy² + ωz²).
//    • Maintain a rolling 30-sample (300ms) max.
//    • When the rolling max crosses the threshold (~12 rad/s for ≥50ms),
//      fire `onMotionPeak` with the peak timestamp.
//    • Debounce 1.5s so a single swing doesn't fire 6 events as the
//      arm decelerates.
//
//  Why 12 rad/s: empirically, a casual full swing peaks the watch's
//  angular speed around 20-30 rad/s at impact, and a putting stroke
//  peaks under 6. 12 catches everything from a wedge to a driver while
//  ignoring everyday wrist motion (walking, picking up a club, etc.).
//
//  The threshold is intentionally LOW — false positives are caught
//  later by the audio gate (no "thwack" means no contact). False
//  negatives (a real swing missed) are much worse UX than the
//  occasional false positive that gets dropped by the audio pass.
//

import Foundation
import CoreMotion

@MainActor
final class MotionMonitor {
    private let manager = CMMotionManager()
    private let queue = OperationQueue()

    /// Tuned threshold (rad/s). Crossing this for ≥ MIN_DURATION counts.
    private let PEAK_THRESHOLD_RAD_PER_SEC: Double = 12
    private let MIN_DURATION_SEC: Double = 0.05
    private let DEBOUNCE_SEC: TimeInterval = 1.5

    private var lastFireTime: Date = .distantPast
    private var aboveSince: Date?

    /// Callback fired on a peak. The Date is when the rolling max first
    /// crossed the threshold (the start of the high-rotation window).
    var onMotionPeak: ((Date) -> Void)?

    /// True once `start()` has been called. Doesn't tell you whether
    /// CoreMotion is actually getting data — only the OS knows that.
    private(set) var isRunning = false

    func start() {
        guard manager.isDeviceMotionAvailable, !isRunning else { return }
        manager.deviceMotionUpdateInterval = 0.01  // 100Hz
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self, let m = motion else { return }
            let ω = m.rotationRate
            let mag = sqrt(ω.x * ω.x + ω.y * ω.y + ω.z * ω.z)
            Task { @MainActor in self.consume(mag: mag) }
        }
        isRunning = true
    }

    func stop() {
        if manager.isDeviceMotionActive { manager.stopDeviceMotionUpdates() }
        aboveSince = nil
        isRunning = false
    }

    private func consume(mag: Double) {
        let now = Date()
        if mag >= PEAK_THRESHOLD_RAD_PER_SEC {
            // Sample is above threshold. Stamp the entry time if we
            // weren't already above.
            if aboveSince == nil { aboveSince = now }
            // Already above and have been for the required duration?
            // Fire (subject to debounce) — once.
            if let start = aboveSince,
               now.timeIntervalSince(start) >= MIN_DURATION_SEC,
               now.timeIntervalSince(lastFireTime) >= DEBOUNCE_SEC
            {
                lastFireTime = now
                onMotionPeak?(start)
                aboveSince = nil  // reset so the next swing can fire
            }
        } else {
            // Sample dipped below — clear the running start.
            aboveSince = nil
        }
    }
}
