//
//  AudioMonitor.swift
//  SacariGolfWatch
//
//  Mic listener that fires when it hears a sharp, high-frequency
//  transient — i.e. the "thwack" of clubface hitting a ball.
//
//  How it works (no Accelerate framework, no FFT shipped here — kept
//  intentionally simple so the watch CPU doesn't roast):
//
//    1. Install an AVAudioEngine input tap at 44.1kHz.
//    2. Per ~1024-frame buffer (~23ms): compute the buffer's RMS energy
//       AND a high-pass-isolated RMS (running difference between
//       consecutive samples, which approximates a derivative = high-pass).
//    3. A ball strike is loud, fast, and short. We trigger when:
//          • high-pass RMS > THRESHOLD_HF
//          • that's at least 5× the trailing 200ms HF baseline
//          • broadband RMS also has a sharp jump (rules out steady wind
//            noise that the HF derivative would amplify)
//    4. Debounce 1.0s so the echo of a single strike doesn't double-fire.
//
//  This is intentionally simpler than a "real" classifier (an audio ML
//  model) — the swing-detector fuses this with the motion peak, so a
//  bird chirp or door slam never matches because there's no
//  high-rotation event near it in time.
//

import Foundation
import AVFoundation

@MainActor
final class AudioMonitor {
    private let engine = AVAudioEngine()
    private var trailingHfRms: [Double] = []
    private let TRAILING_SAMPLES = 10  // ~230ms of history at 23ms/buf
    private let THRESHOLD_HF: Double = 0.012  // empirical; tune on device
    private let HF_RATIO_GATE: Double = 5.0
    private let DEBOUNCE_SEC: TimeInterval = 1.0
    private var lastFireTime: Date = .distantPast

    /// Called when a candidate ball-strike sound is detected. Watch can
    /// pair this with motion to confirm.
    var onTransient: ((Date) -> Void)?

    private(set) var isRunning = false

    func start() async {
        guard !isRunning else { return }
        do {
            // Watch audio session requires explicit activation.
            try AVAudioSession.sharedInstance().setCategory(
                .playAndRecord,
                mode: .measurement,
                options: [.duckOthers, .mixWithOthers],
            )
            try AVAudioSession.sharedInstance().setActive(true)

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)

            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buf, _ in
                guard let self else { return }
                guard let channel = buf.floatChannelData?[0] else { return }
                let count = Int(buf.frameLength)
                if count < 4 { return }

                // Broadband RMS
                var sumSq: Double = 0
                for i in 0..<count {
                    let v = Double(channel[i])
                    sumSq += v * v
                }
                let rms = sqrt(sumSq / Double(count))

                // High-pass RMS — first-difference between samples. A
                // bird chirp or hum has smooth waveform → low HF; a
                // sharp ball strike has near-step transient → high HF.
                var hfSumSq: Double = 0
                for i in 1..<count {
                    let d = Double(channel[i]) - Double(channel[i-1])
                    hfSumSq += d * d
                }
                let hfRms = sqrt(hfSumSq / Double(count - 1))

                Task { @MainActor in
                    self.consume(hfRms: hfRms, broadbandRms: rms)
                }
            }

            try engine.start()
            isRunning = true
        } catch {
            // Mic permission denied or hardware unavailable. The watch
            // user can still tag swings manually via the override button.
            isRunning = false
        }
    }

    func stop() {
        if isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            try? AVAudioSession.sharedInstance().setActive(false)
            isRunning = false
        }
        trailingHfRms.removeAll()
    }

    private func consume(hfRms: Double, broadbandRms: Double) {
        // Maintain a rolling baseline of recent HF energy.
        trailingHfRms.append(hfRms)
        if trailingHfRms.count > TRAILING_SAMPLES { trailingHfRms.removeFirst() }
        let baseline = trailingHfRms.dropLast(2).reduce(0, +) / Double(max(1, trailingHfRms.count - 2))

        let now = Date()
        guard now.timeIntervalSince(lastFireTime) >= DEBOUNCE_SEC else { return }

        // Three-condition gate: HF above absolute threshold, HF jump
        // above baseline ratio, broadband not muted (rules out gloved
        // tap on the watch itself which is HF-rich but quiet overall).
        let absoluteHit = hfRms > THRESHOLD_HF
        let ratioHit    = baseline > 0 ? (hfRms / baseline >= HF_RATIO_GATE) : true
        let loudEnough  = broadbandRms > 0.005

        if absoluteHit && ratioHit && loudEnough {
            lastFireTime = now
            onTransient?(now)
        }
    }
}
