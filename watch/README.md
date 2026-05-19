# Sacari Golf — Apple Watch

A native watchOS companion to the iOS app. Built in Swift / SwiftUI; talks
directly to the same Node backend over HTTPS. Not bundled with the iOS app
(yet) — it's a standalone watch app.

## v1 Scope

Tight on purpose. Everything else stays on the phone.

1. **Login** — email + password against `/auth/login`. JWT stored in
   Keychain. Auto-logs in on next launch if the token is still there.
2. **Match list + scoring** — pick a non-completed match from `/matches`,
   tap +/- per hole, submit scores via `/matches/:id/scores`. Mirrors the
   iOS scoring flow but with watch-native controls.
3. **Distance to pin** — live GPS distance to the current hole's pin
   coordinate (haversine). For premium users, also shows **plays-like**
   yardage adjusted for slope (DEM elevation delta) and weather (wind
   along-shot component, temperature, altitude, rain). Mirrors the
   formulas from `mobile/lib/weatherAdjust.ts`.
4. **Auto-detect swing** — fuses CoreMotion's gyroscope (angular-velocity
   spike) with an AVAudioEngine mic listener (high-frequency transient
   peak, the "thwack" of clubface-on-ball). When BOTH happen within a
   ~120ms window we register a confirmed swing-with-contact. There's a
   manual override button for misdetections / silent practice swings.
5. **Chat** — DM list + match chat. Polling-based (no WebSocket), same
   endpoints the iOS app uses.

## Folder structure

```
watch/
├── README.md                       — this file
└── SacariGolfWatch/               — Xcode project lives here
    ├── App/
    │   ├── SacariGolfWatchApp.swift   — @main entry, environment objects
    │   └── ContentView.swift            — root navigation (Login | TabHome)
    ├── Auth/
    │   ├── KeychainStore.swift          — secure JWT storage
    │   ├── AuthStore.swift              — @Observable session state
    │   └── LoginView.swift
    ├── Networking/
    │   ├── APIClient.swift              — typed HTTP wrapper + endpoints
    │   └── Models.swift                 — Codable structs matching backend
    ├── Matches/
    │   ├── MatchListView.swift
    │   └── ScoringView.swift            — main scoring + distance + shot UI
    ├── Distance/
    │   ├── LocationManager.swift        — CoreLocation wrapper
    │   └── PlaysLike.swift              — port of weatherAdjust.ts
    ├── Swing/
    │   ├── SwingDetector.swift          — motion + audio fusion + override
    │   ├── MotionMonitor.swift          — CMMotionManager wrapper
    │   └── AudioMonitor.swift           — AVAudioEngine mic + band-energy
    └── Chat/
        ├── ConversationListView.swift
        └── ChatView.swift
```

## Setup (on a Mac with Xcode 15+)

You need a Mac for this — watchOS dev requires Xcode. Cloud Mac options
work fine (MacInCloud, MacStadium, Xcode Cloud) if you don't have a local
one.

1. **Create the Xcode project**
   - File → New → Project → watchOS → **App** (NOT "App for iOS App")
   - Product Name: `SacariGolfWatch`
   - Bundle ID: `com.sacarigolf.watch` (or your reverse-DNS)
   - Interface: **SwiftUI**
   - Language: Swift
   - Deployment target: **watchOS 10.0**
   - Save into `watch/` (this folder)

2. **Drop in the Swift files**
   - In Finder, drag each `App/`, `Auth/`, `Networking/`, etc. subfolder
     into the Xcode project navigator
   - When prompted: **Copy items if needed** ON, **Create groups**
   - All files should target the watch app target

3. **Set the API base URL**
   - Open `Networking/APIClient.swift`
   - Replace `API_BASE` with your Railway URL (the same one the iOS app
     uses; check `mobile/lib/api.ts` if you forgot)

4. **Add Info.plist usage descriptions**
   - `NSLocationWhenInUseUsageDescription` —
     "Sacari uses your location to measure distance to the pin and track
     where your shots land."
   - `NSMicrophoneUsageDescription` —
     "Sacari listens for the sound of club-on-ball contact to auto-detect
     swings. Audio is processed live and never recorded."
   - `NSMotionUsageDescription` —
     "Sacari uses the watch's gyroscope to detect golf swings."

5. **Capabilities**
   - Background Modes → check **Audio, AirPlay, and Picture in Picture**
     (lets the mic listener keep running while scoring)
   - HealthKit (optional, for future heart-rate / steps integration —
     not used in v1)

6. **Signing**
   - Pick your Apple Developer team. The bundle ID needs to be unique
     in your team. For local testing without a paid account, change it
     to anything ending in `.dev.<random>`.

7. **Build**
   - Pick a paired Apple Watch simulator (Series 9 or Ultra 2 — newer
     simulators handle CoreMotion + audio better in tests)
   - Cmd+R to run

The login screen should appear. After successful login you'll land on
the match list. Pick an in-progress match to start scoring.

## What's intentionally NOT here

- Swing-analyzer video / pose tracking — that's iPhone-only
- Maps — watch screens are too small for satellite tiles
- Course search / match creation — start the round on the phone, score
  it on the watch. The watch only lists matches you've already created
- Social feed / Finds / Posts / Leaderboards — phone-only
- Premium purchase flow — buy on the phone, the watch reads `is_premium`
  off `/users/me` and unlocks plays-like accordingly

## Iterating

When the backend adds new endpoints, only `Networking/Models.swift` and
`APIClient.swift` need to update. Views read off typed structs and don't
care about wire format details.

If the watch app eventually ships bundled with the iOS app (single App
Store listing, paired install), move this whole `SacariGolfWatch/`
folder into `mobile/ios/` and add it as a target there. The Swift source
ports cleanly — only the project file changes.
