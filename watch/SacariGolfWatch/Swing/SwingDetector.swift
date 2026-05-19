//
//  SwingDetector.swift
//  SacariGolfWatch
//
//  Fuses MotionMonitor + AudioMonitor into a single "confirmed swing-
//  with-contact" event. Either monitor alone is too noisy:
//
//    • Motion alone: a hard wrist flick while reaching for a drink looks
//      identical to a half-swing
//    • Audio alone: clapping, talking, golf clubs clinking in the bag,
//      ambient traffic — all trigger
//
//  But the COMBO is highly specific to golf:
//    • A high-rotation event happened
//    • A sharp loud transient happened within ±120ms of that event
//
//  When both fire we emit `onConfirmedSwing`. The UI vibrates the wrist,
//  shows a "shot recorded" toast, and prompts the user to either confirm
//  (with their currently-selected club) or override (wrong club / silent
//  practice swing).
//
//  Public lifecycle:
//    detector.start()  — arms both monitors
//    detector.stop()   — call when scoring screen disappears
//    detector.manualTrigger()  — for the override button
//

import Foundation

@MainActor
final class SwingDetector: ObservableObject {
    private let motion = MotionMonitor()
    private let audio  = AudioMonitor()

    /// How tight a window we require between motion peak and audio
    /// transient. 120ms catches the natural ball-strike lag (motion
    /// peaks ~50ms before contact; sound reaches the watch ~5-30ms
    /// after) plus a safety margin.
    private let FUSION_WINDOW_SEC: TimeInterval = 0.12

    /// Last motion peak time, waiting for an audio match within window.
    private var pendingMotionAt: Date?
    private var pendingAudioAt: Date?

    /// True iff both monitors are armed. The view binds the "auto-detect
    /// is on" indicator to this.
    @Published private(set) var isArmed: Bool = false

    /// Most recent confirmed swing — handy for showing "last shot N
    /// seconds ago" in the UI without separately tracking history.
    @Published private(set) var lastConfirmedAt: Date?

    /// Whether the LATEST confirmed swing came from auto-fusion or a
    /// manual button press. UI displays a different badge for each so
    /// the user can recognise a tap-recorded shot in their history.
    @Published private(set) var lastWasManual: Bool = false

    /// Fires when both monitors line up within FUSION_WINDOW_SEC. The
    /// view binds this to the shot-end-capture prompt.
    var onConfirmedSwing: (() -> Void)?

    init() {
        motion.onMotionPeak = { [weak self] at in
            self?.handleMotion(at: at)
        }
        audio.onTransient = { [weak self] at in
            self?.handleAudio(at: at)
        }
    }

    func start() async {
        motion.start()
        await audio.start()
        isArmed = motion.isRunning  // audio may legitimately be off (no mic perm)
    }

    func stop() {
        motion.stop()
        audio.stop()
        pendingMotionAt = nil
        pendingAudioAt  = nil
        isArmed = false
    }

    /// User says "I just swung, the detector missed it." Force-fire the
    /// confirmation as if the audio + motion pair had matched.
    func manualTrigger() {
        lastWasManual = true
        lastConfirmedAt = Date()
        onConfirmedSwing?()
    }

    // ─── Fusion plumbing ─────────────────────────────────────────

    private func handleMotion(at: Date) {
        // If we have a pending audio event within the window, fire.
        if let audioAt = pendingAudioAt,
           abs(at.timeIntervalSince(audioAt)) <= FUSION_WINDOW_SEC
        {
            fire()
            return
        }
        // Otherwise hold the motion peak; it expires when the window
        // passes.
        pendingMotionAt = at
        scheduleExpiry(of: at, for: .motion)
    }

    private func handleAudio(at: Date) {
        if let motionAt = pendingMotionAt,
           abs(at.timeIntervalSince(motionAt)) <= FUSION_WINDOW_SEC
        {
            fire()
            return
        }
        pendingAudioAt = at
        scheduleExpiry(of: at, for: .audio)
    }

    private func fire() {
        pendingMotionAt = nil
        pendingAudioAt  = nil
        lastWasManual = false
        lastConfirmedAt = Date()
        onConfirmedSwing?()
    }

    private enum PendingKind { case motion, audio }
    private func scheduleExpiry(of at: Date, for kind: PendingKind) {
        let when = at.addingTimeInterval(FUSION_WINDOW_SEC)
        let delay = max(0.01, when.timeIntervalSinceNow)
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self else { return }
            await MainActor.run {
                switch kind {
                case .motion:
                    if self.pendingMotionAt == at { self.pendingMotionAt = nil }
                case .audio:
                    if self.pendingAudioAt == at { self.pendingAudioAt = nil }
                }
            }
        }
    }
}
