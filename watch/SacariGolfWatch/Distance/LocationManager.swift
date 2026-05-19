//
//  LocationManager.swift
//  SacariGolfWatch
//
//  Thin wrapper around CLLocationManager. Exposes the latest fix as a
//  @Published property so SwiftUI views auto-rerender when the player
//  moves. We start updating on demand (when a scoring view appears),
//  not at app launch — saves battery during the chat / match-list views.
//
//  Accuracy: requested `kCLLocationAccuracyBest`. On Series 6+ hardware
//  this typically gives 3-8m fixes outdoors. Plenty for hole-distance
//  display (golf pin tolerances are ~5m anyway). For shot-tracking start/
//  end points we'll average a small window of fixes to tighten further
//  — same approach the iOS app uses.
//

import Foundation
import CoreLocation
import Combine

@MainActor
final class LocationManager: NSObject, ObservableObject, CLLocationManagerDelegate {
    static let shared = LocationManager()

    private let manager = CLLocationManager()

    @Published private(set) var lastFix: CLLocation?
    @Published private(set) var authorization: CLAuthorizationStatus = .notDetermined
    @Published private(set) var isUpdating: Bool = false

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter  = 2  // only emit when player moves ≥ 2m
        authorization = manager.authorizationStatus
    }

    /// Ask for permission + start streaming fixes. Idempotent. Call when
    /// a view that needs location appears.
    func start() {
        switch authorization {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            // Nothing to do — the UI surfaces an inline "enable in
            // Settings" message.
            return
        default:
            break
        }
        manager.startUpdatingLocation()
        isUpdating = true
    }

    /// Stop the GPS stream — call from `.onDisappear` of a screen so the
    /// chip on the wrist isn't burning power between holes.
    func stop() {
        manager.stopUpdatingLocation()
        isUpdating = false
    }

    // ── Delegate ───────────────────────────────────────────────────

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        Task { @MainActor in
            self.authorization = m.authorizationStatus
            if self.authorization == .authorizedWhenInUse && self.isUpdating {
                m.startUpdatingLocation()
            }
        }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        // Use only fresh fixes — the OS sometimes hands back cached
        // entries from before the previous session. Anything older than
        // 5s is suspect.
        let now = Date()
        let fresh = locations.last { now.timeIntervalSince($0.timestamp) < 5 }
        guard let fix = fresh else { return }
        Task { @MainActor in self.lastFix = fix }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        // Non-fatal — the next valid fix will reset us. Silent on
        // purpose; surfacing every transient failure spams the watch UI.
    }
}

// ─── Distance helpers ──────────────────────────────────────────────

/// Great-circle distance between two lat/lng pairs, in YARDS. Mirrors
/// the iOS app's `distYards()` in `mobile/lib/golfMath.ts` so the watch
/// + phone agree on every yardage they display.
func distanceYards(_ a: CLLocation, lat: Double, lng: Double) -> Double {
    let other = CLLocation(latitude: lat, longitude: lng)
    let m = a.distance(from: other)
    return m * 1.0936132983
}
