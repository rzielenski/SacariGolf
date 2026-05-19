//
//  MatchListView.swift
//  SacariGolfWatch
//
//  Lists the user's in-progress (and recent) matches. Tapping a row opens
//  the ScoringView for that match. Practice rounds and completed matches
//  are filtered out — the watch is intended for live play only; finished
//  matches are for the phone's scorecard view.
//
//  Pull-to-refresh isn't really a watch gesture; we rely on a small
//  refresh button + auto-refresh on appear.
//

import SwiftUI

struct MatchListView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var matches: [MatchSummary] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        List {
            Section {
                if loading && matches.isEmpty {
                    HStack {
                        ProgressView()
                        Text("Loading matches…")
                            .foregroundStyle(.secondary)
                    }
                } else if matches.isEmpty {
                    Text("No active matches. Start one on the phone.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(matches) { m in
                        NavigationLink(value: m.match_id) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(displayName(m))
                                    .font(.body)
                                    .lineLimit(1)
                                Text(m.match_type.uppercased())
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            Section {
                Button("Refresh", action: { Task { await load() } })
                Button("Sign out", role: .destructive) { auth.logout() }
            }

            if let err = errorText {
                Text(err)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle("My Matches")
        .navigationDestination(for: String.self) { matchId in
            ScoringView(matchId: matchId)
        }
        .task { await load() }
    }

    private func displayName(_ m: MatchSummary) -> String {
        m.name ?? "\(m.match_type.capitalized) match"
    }

    private func load() async {
        loading = true
        errorText = nil
        do {
            let all = try await APIClient.shared.matches()
            // Hide completed + cancelled; surface practice rounds too
            // since they're useful on the watch.
            matches = all.filter { !$0.completed && !$0.cancelled }
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }
}
