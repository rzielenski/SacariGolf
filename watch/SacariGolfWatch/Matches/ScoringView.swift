//
//  ScoringView.swift
//  SacariGolfWatch
//
//  The main scoring + shot-tracking screen during a live round. Wears
//  three hats:
//
//   1. SCORECARD — current hole #, par, stroke counter (+/-), score-to-
//      par for the round so far.
//   2. DISTANCE  — live GPS yardage to the hole's pin coordinate; plus
//      a plays-like number for premium users (slope + weather).
//   3. SHOT LOG  — auto-detected swings (motion + audio fusion) saved as
//      shot segments under the current hole. Each detected swing arms
//      the "tap when you reach the ball" prompt; tapping captures the
//      end coordinate and posts a complete shot segment to the backend.
//      A manual override button records a shot the detector missed.
//
//  Submitting the final scorecard happens on the LAST hole via a
//  dedicated Submit button — we don't auto-submit on every stroke
//  change because the iOS app may also be live-scoring the same match
//  and the last-writer-wins semantics would clobber each other.
//

import SwiftUI
import CoreLocation
import WatchKit

struct ScoringView: View {
    let matchId: String
    @EnvironmentObject var auth: AuthStore
    @StateObject private var location = LocationManager.shared
    @StateObject private var detector = SwingDetector()

    // ── Course / round state ───────────────────────────────────────
    @State private var match: MatchSummary?
    @State private var course: Course?
    @State private var teebox: Teebox?
    @State private var weather: Weather?
    @State private var currentHole: Int = 0  // index into teebox.holes
    @State private var scores: [Int] = []
    @State private var loadError: String?
    @State private var submitting = false
    @State private var submitNote: String?

    // ── Shot tracking state ────────────────────────────────────────
    /// When non-nil, a swing was just detected and we're waiting for
    /// the user to walk to the ball and tap "I reached it" to capture
    /// the end coord.
    @State private var pendingShotStart: CLLocation?
    @State private var pendingShotAt: Date?
    @State private var club: String = "7i"

    // ── Layout ─────────────────────────────────────────────────────

    var body: some View {
        if let course, let teebox, let holes = teebox.holes, !holes.isEmpty, currentHole < holes.count {
            let hole = holes[currentHole]
            ScrollView {
                VStack(spacing: 8) {
                    holeHeader(hole: hole, holesCount: holes.count)
                    distanceBlock(hole: hole)
                    scoreCounter(holeIndex: currentHole, hole: hole)
                    shotTrackingBlock(hole: hole)
                    navRow(holesCount: holes.count)

                    if currentHole == holes.count - 1 {
                        Button(action: submit) {
                            if submitting { ProgressView().tint(.black) }
                            else { Text("Submit scorecard").fontWeight(.bold) }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.yellow)
                        .disabled(submitting)
                    }
                    if let n = submitNote {
                        Text(n).font(.caption2).foregroundStyle(.green)
                    }
                }
                .padding(.horizontal, 4)
            }
            .navigationTitle("\(course.course_name)")
            .onAppear { Task { await detector.start() } }
            .onDisappear {
                detector.stop()
                location.stop()
            }
        } else if let err = loadError {
            VStack(spacing: 8) {
                Text("Couldn't load match").font(.caption)
                Text(err).font(.caption2).foregroundStyle(.red)
                Button("Retry") { Task { await load() } }
            }
        } else {
            ProgressView()
                .task {
                    location.start()
                    await load()
                    setupDetectorCallback()
                }
        }
    }

    // ─── Sections ──────────────────────────────────────────────────

    @ViewBuilder
    private func holeHeader(hole: Hole, holesCount: Int) -> some View {
        HStack {
            Text("Hole \(hole.hole_num) / \(holesCount)")
                .font(.headline)
            Spacer()
            Text("Par \(hole.par)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.top, 2)
    }

    @ViewBuilder
    private func distanceBlock(hole: Hole) -> some View {
        VStack(spacing: 2) {
            if let pinLat = hole.pin_lat, let pinLng = hole.pin_lng {
                if let fix = location.lastFix {
                    let yards = Int(distanceYards(fix, lat: pinLat, lng: pinLng))
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(yards)")
                            .font(.system(size: 32, weight: .heavy, design: .serif))
                            .foregroundStyle(.yellow)
                        Text("yds")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if auth.isPremium {
                        playsLikeRow(hole: hole, baseYards: Double(yards))
                    }
                } else {
                    Text("Getting GPS…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No pin data for this hole")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(.gray.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func playsLikeRow(hole: Hole, baseYards: Double) -> some View {
        // Slope: from player elevation to pin_elevation_m (if known).
        let playerElevM = location.lastFix?.altitude ?? 0
        let pinElevM = hole.pin_elevation_m ?? playerElevM
        let elevDelta = pinElevM - playerElevM

        // Shot bearing — player to pin.
        let bearing = shotBearing(from: location.lastFix, toLat: hole.pin_lat ?? 0, toLng: hole.pin_lng ?? 0)

        let result = playsLike(.init(
            baseYards: baseYards,
            elevationDeltaM: elevDelta,
            weather: weather,
            shotBearingDeg: bearing,
            homeElevationFt: 0,  // wire in when User.home_course elevation is fetched
        ))
        if result.totalDelta != 0 {
            Text("Plays \(result.playsLikeYds) (\(result.totalDelta > 0 ? "+" : "")\(result.totalDelta))")
                .font(.caption)
                .foregroundStyle(.yellow.opacity(0.85))
        }
    }

    @ViewBuilder
    private func scoreCounter(holeIndex: Int, hole: Hole) -> some View {
        HStack(spacing: 12) {
            Button {
                if scores[holeIndex] > 1 { scores[holeIndex] -= 1 }
            } label: {
                Text("−").font(.system(size: 28, weight: .heavy))
            }
            .buttonStyle(.bordered)

            Text("\(scores[holeIndex])")
                .font(.system(size: 40, weight: .heavy, design: .serif))
                .frame(minWidth: 50)

            Button {
                scores[holeIndex] += 1
            } label: {
                Text("+").font(.system(size: 28, weight: .heavy))
            }
            .buttonStyle(.borderedProminent)
            .tint(.yellow)
        }
    }

    @ViewBuilder
    private func shotTrackingBlock(hole: Hole) -> some View {
        VStack(spacing: 6) {
            // Club picker — single tap cycles forward, long-press opens
            // the picker. Compact since watch screen is tiny.
            HStack {
                Text("Club")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Picker("", selection: $club) {
                    ForEach(CLUB_KEYS, id: \.self) { c in
                        Text(c.uppercased()).tag(c)
                    }
                }
                .pickerStyle(.wheel)
                .frame(height: 60)
            }

            // Detector status / pending-shot prompt.
            if let _ = pendingShotStart {
                // Swing was detected — waiting for the user to reach
                // the ball and tap "Got it" to capture the end coord.
                VStack(spacing: 4) {
                    Text("Walking to ball…").font(.caption)
                    Button("Got it — record shot") {
                        captureShotEnd(holeNum: hole.hole_num)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    Button("Cancel — not a real swing") {
                        pendingShotStart = nil
                        pendingShotAt = nil
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.red)
                }
                .padding(.vertical, 4)
            } else {
                HStack {
                    Image(systemName: detector.isArmed
                          ? "dot.radiowaves.left.and.right"
                          : "exclamationmark.triangle")
                        .foregroundStyle(detector.isArmed ? .yellow : .orange)
                    Text(detector.isArmed
                         ? "Auto-detect armed"
                         : "Tap below to record manually")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Button("Manual: I swung") {
                    armPendingShot()
                    detector.manualTrigger()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
        .background(.gray.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private func navRow(holesCount: Int) -> some View {
        HStack {
            Button("◀ Prev") {
                if currentHole > 0 { currentHole -= 1 }
            }
            .disabled(currentHole == 0)
            Spacer()
            Button(currentHole == holesCount - 1 ? "Last" : "Next ▶") {
                if currentHole < holesCount - 1 { currentHole += 1 }
            }
            .disabled(currentHole == holesCount - 1)
        }
        .font(.caption)
    }

    // ─── Logic ──────────────────────────────────────────────────────

    private func load() async {
        loadError = nil
        do {
            // 1) Full match detail — gives us the player roster with the
            //    current user's teebox_id + course_id + any in-progress
            //    hole_scores. Need the detail (not the summary) because
            //    the summary endpoint omits teebox_id.
            let detail = try await APIClient.shared.match(id: matchId)
            guard let me = detail.players.first(where: { $0.user_id == auth.user?.user_id }),
                  let teeboxId  = me.teebox_id,
                  let courseId  = me.course_id
            else {
                loadError = "Pick a teebox on the phone first — the watch needs to know which tees you're playing."
                return
            }

            // 2) Hydrate the full course → holes for the chosen teebox.
            let courseDetail = try await APIClient.shared.course(id: courseId)
            guard let tee = courseDetail.teeboxes?.first(where: { $0.teebox_id == teeboxId }),
                  let holes = tee.holes, !holes.isEmpty
            else {
                loadError = "This teebox has no hole data on record. Try a different one on the phone."
                return
            }

            // 3) Stash everything, seed +/- counters from any partial
            //    scores already submitted (live-scoring resume case).
            course = courseDetail
            teebox = tee
            let sorted = holes.sorted { $0.hole_num < $1.hole_num }
            // Inline-set the .holes on teebox so the View uses the sorted
            // order without us threading a separate state.
            teebox = Teebox(
                teebox_id: tee.teebox_id,
                name: tee.name,
                course_rating: tee.course_rating,
                slope_rating: tee.slope_rating,
                total_yards: tee.total_yards,
                num_holes: tee.num_holes,
                par: tee.par,
                holes: sorted,
            )
            scores = (0..<sorted.count).map { i in
                (me.hole_scores?.indices.contains(i) == true ? me.hole_scores![i] : sorted[i].par)
            }
            // Advance to the first unscored hole so the watch doesn't
            // start on hole 1 when the player's already on hole 6.
            currentHole = me.hole_scores?.count ?? 0
            if currentHole >= sorted.count { currentHole = sorted.count - 1 }

            // 4) Optional weather lookup for plays-like (premium only).
            //    Best-effort — never fail the whole load on this.
            if auth.isPremium, let lat = courseDetail.latitude, let lng = courseDetail.longitude {
                weather = try? await APIClient.shared.weather(lat: lat, lng: lng)
            }
        } catch {
            loadError = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func setupDetectorCallback() {
        detector.onConfirmedSwing = {
            // Detector fired — arm the pending shot if not already armed.
            armPendingShot()
        }
    }

    private func armPendingShot() {
        guard let fix = location.lastFix, pendingShotStart == nil else { return }
        pendingShotStart = fix
        pendingShotAt = Date()
        WatchHaptic.tap()
    }

    private func captureShotEnd(holeNum: Int) {
        guard let start = pendingShotStart,
              let end = location.lastFix
        else {
            pendingShotStart = nil; pendingShotAt = nil; return
        }

        // Compute total yards immediately so the UI shows it next time
        // we re-render the hole.
        let totalYds = Int(distanceYards(start, lat: end.coordinate.latitude, lng: end.coordinate.longitude))

        let segment = ShotSegment(
            start: Coord(lat: start.coordinate.latitude,
                         lng: start.coordinate.longitude,
                         elevation_m: start.altitude),
            end:   Coord(lat: end.coordinate.latitude,
                         lng: end.coordinate.longitude,
                         elevation_m: end.altitude),
            club: club,
            lie: nil,
            recorded_at: ISO8601DateFormatter().string(from: pendingShotAt ?? Date()),
            plays_like_yds: nil,
            total_yds: totalYds,
        )
        let req = SaveShotsRequest(shots: [segment])
        pendingShotStart = nil
        pendingShotAt = nil
        Task {
            do {
                try await APIClient.shared.saveShots(matchId: matchId, holeNum: holeNum, body: req)
            } catch {
                // The shot is already shown locally — log only.
                print("Save shot failed:", error)
            }
        }
        WatchHaptic.success()
    }

    private func submit() {
        guard let course, let teebox else { return }
        submitting = true
        submitNote = nil
        let body = SubmitScoresRequest(
            holeScores: scores,
            holeStats: [:],
            courseId: course.course_id,
            teeboxId: teebox.teebox_id,
        )
        Task {
            do {
                try await APIClient.shared.submitScores(matchId: matchId, body: body)
                submitNote = "Submitted — review on the phone."
            } catch {
                submitNote = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            submitting = false
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────

let CLUB_KEYS = [
    "driver", "3w", "5w", "hybrid",
    "4i", "5i", "6i", "7i", "8i", "9i",
    "pw", "gw", "sw", "lw", "putter", "chip",
]

/// Bearing from a player fix to a target lat/lng, in degrees clockwise
/// from north. Returns 0 when player fix is nil.
private func shotBearing(from fix: CLLocation?, toLat: Double, toLng: Double) -> Double {
    guard let fix else { return 0 }
    let φ1 = fix.coordinate.latitude  * .pi / 180
    let φ2 = toLat * .pi / 180
    let Δλ = (toLng - fix.coordinate.longitude) * .pi / 180
    let y = sin(Δλ) * cos(φ2)
    let x = cos(φ1) * sin(φ2) - sin(φ1) * cos(φ2) * cos(Δλ)
    return (atan2(y, x) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
}

/// Watch haptic helpers — used to confirm shot capture without needing
/// the user to look at the screen.
import WatchKit
enum WatchHaptic {
    static func tap()      { WKInterfaceDevice.current().play(.click) }
    static func success()  { WKInterfaceDevice.current().play(.success) }
}
