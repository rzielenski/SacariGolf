//
//  ChatView.swift
//  SacariGolfWatch
//
//  Single 1:1 thread. Polls /dm/:otherId every 6 seconds while the view
//  is alive to pick up the other user's new messages. Sending uses
//  POST /dm/:otherId; the response is appended optimistically into the
//  local list so the user sees their message immediately.
//
//  Composition: a built-in text-input button that opens the watch's
//  full-screen input UI (dictation, scribble, or paired-iPhone keyboard).
//  No inline keyboard — watchOS doesn't have one.
//

import SwiftUI

struct ChatView: View {
    let otherId: String
    let otherName: String

    @EnvironmentObject var auth: AuthStore
    @State private var messages: [DirectMessage] = []
    @State private var composing: String = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(messages) { m in
                            messageBubble(m: m)
                                .id(m.message_id)
                        }
                    }
                    .padding(.vertical, 4)
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.message_id, anchor: .bottom) }
                    }
                }
            }
            HStack(spacing: 6) {
                TextField("Message", text: $composing)
                    .textFieldStyle(.plain)
                    .padding(6)
                    .background(.gray.opacity(0.2))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Button {
                    Task { await send() }
                } label: {
                    if sending { ProgressView() }
                    else      { Image(systemName: "arrow.up.circle.fill") }
                }
                .disabled(composing.trimmingCharacters(in: .whitespaces).isEmpty || sending)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            if let err = errorText {
                Text(err).font(.caption2).foregroundStyle(.red)
            }
        }
        .navigationTitle(otherName)
        .task {
            await load()
            startPolling()
        }
        .onDisappear { pollTask?.cancel() }
    }

    @ViewBuilder
    private func messageBubble(m: DirectMessage) -> some View {
        let mine = m.user_id == auth.user?.user_id
        HStack {
            if mine { Spacer(minLength: 16) }
            Text(m.body)
                .font(.footnote)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(mine ? .yellow : .gray.opacity(0.2))
                .foregroundStyle(mine ? .black : .white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            if !mine { Spacer(minLength: 16) }
        }
        .padding(.horizontal, 4)
    }

    private func load() async {
        do {
            messages = try await APIClient.shared.dm(userId: otherId)
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func send() async {
        let text = composing.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        sending = true
        composing = ""
        do {
            let msg = try await APIClient.shared.sendDM(userId: otherId, body: text)
            // Append optimistically — the next poll will reconcile if
            // the server gave us a different message_id (shouldn't, but
            // defensive).
            messages.append(msg)
        } catch {
            errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
        }
        sending = false
    }

    /// Polls every 6s while the view is visible. Cancelled on disappear.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [otherId] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 6 * NSEC_PER_SEC)
                if Task.isCancelled { return }
                if let latest = try? await APIClient.shared.dm(userId: otherId) {
                    // Only update if message count changed — otherwise
                    // we'd thrash the list every 6s for nothing.
                    if latest.count != messages.count {
                        await MainActor.run { messages = latest }
                    }
                }
            }
        }
    }
}
