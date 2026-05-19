//
//  ConversationListView.swift
//  SacariGolfWatch
//
//  Lists the user's existing DM threads. Tapping a row opens the
//  thread. Watch users start conversations from the phone — we don't
//  bother with a "new DM → pick a friend" flow here, since search +
//  pick on a tiny screen is awkward.
//

import SwiftUI

struct ConversationListView: View {
    @State private var convs: [Conversation] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        List {
            if loading && convs.isEmpty {
                HStack {
                    ProgressView()
                    Text("Loading…").foregroundStyle(.secondary)
                }
            } else if convs.isEmpty {
                Text("No conversations. Start one on the phone.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(convs) { c in
                    NavigationLink(value: c) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack {
                                Text(c.other_username)
                                    .fontWeight(c.unread ?? false ? .bold : .regular)
                                Spacer()
                                if c.unread ?? false {
                                    Circle()
                                        .fill(.yellow)
                                        .frame(width: 6, height: 6)
                                }
                            }
                            if let last = c.last_message {
                                Text(last)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                    }
                }
            }

            Button("Refresh") { Task { await load() } }
                .font(.caption)
            if let err = errorText {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
        }
        .navigationTitle("Chats")
        .navigationDestination(for: Conversation.self) { c in
            ChatView(otherId: c.other_id, otherName: c.other_username)
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        do {
            convs = try await APIClient.shared.conversations()
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }
}
