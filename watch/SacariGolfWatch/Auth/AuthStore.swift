//
//  AuthStore.swift
//  SacariGolfWatch
//
//  Observable session state. Holds the current User (when logged in) and
//  acts as the single source of truth for "are we authenticated." Views
//  observe this via @EnvironmentObject and re-render when the user logs
//  in / out.
//
//  Also subscribes to APIClient's "unauthorized" notification so a token
//  expiry mid-request bounces the user back to login automatically.
//

import SwiftUI

@MainActor
final class AuthStore: ObservableObject {
    @Published var user: User?
    @Published var isBooting: Bool = true

    init() {
        // Listen for 401s coming up from the API layer.
        NotificationCenter.default.addObserver(
            forName: APIClient.unauthorizedNotification,
            object: nil, queue: .main,
        ) { [weak self] _ in
            Task { @MainActor in self?.user = nil }
        }

        // Boot: if there's a saved JWT, fetch /users/me to confirm it's
        // still valid and hydrate the current user. Otherwise stay
        // unauthenticated. Either way, flip isBooting to false so the UI
        // can render past the splash.
        Task { @MainActor in
            if KeychainStore.shared.token != nil {
                do {
                    self.user = try await APIClient.shared.me()
                } catch {
                    // 401/403/offline — clear local session and let the
                    // login screen handle the retry.
                    KeychainStore.shared.token = nil
                    self.user = nil
                }
            }
            self.isBooting = false
        }
    }

    func login(email: String, password: String) async throws {
        let res = try await APIClient.shared.login(email: email, password: password)
        KeychainStore.shared.token = res.token
        await MainActor.run { self.user = res.user }
    }

    func logout() {
        KeychainStore.shared.token = nil
        user = nil
    }

    var isAuthenticated: Bool { user != nil }
    var isPremium: Bool { user?.is_premium ?? false }
}
