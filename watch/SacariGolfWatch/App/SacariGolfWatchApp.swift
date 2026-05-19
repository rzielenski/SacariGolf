//
//  SacariGolfWatchApp.swift
//  SacariGolfWatch
//
//  App entry. AuthStore lives at the root via @StateObject + injected
//  into the environment so every child view can read the session.
//

import SwiftUI

@main
struct SacariGolfWatchApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
        }
    }
}
