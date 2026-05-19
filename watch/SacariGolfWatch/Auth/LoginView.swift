//
//  LoginView.swift
//  SacariGolfWatch
//
//  Single-screen email + password sign-in. Watch screens are tiny, so:
//    • Two inputs stacked vertically with the new SwiftUI text-field
//      keyboard automatically taking over the whole screen on focus
//    • Sign-in button is the full width — biggest tap target the watch
//      can offer
//    • Error message appears inline; no separate alert (the modal
//      dismissal is fiddly on watch)
//
//  No "create account" flow — that's iPhone-only. The watch assumes the
//  user has already registered on the phone.
//

import SwiftUI

struct LoginView: View {
    @EnvironmentObject var auth: AuthStore
    @State private var email = ""
    @State private var password = ""
    @State private var submitting = false
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("Sacari Golf")
                    .font(.headline)
                    .foregroundStyle(.yellow)
                    .padding(.top, 4)

                TextField("Email", text: $email)
                    .textContentType(.emailAddress)
                    .submitLabel(.next)
                    .padding(8)
                    .background(.gray.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                SecureField("Password", text: $password)
                    .textContentType(.password)
                    .submitLabel(.done)
                    .padding(8)
                    .background(.gray.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 6))

                Button(action: submit) {
                    if submitting {
                        ProgressView().tint(.black)
                    } else {
                        Text("Sign in")
                            .fontWeight(.bold)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(.yellow)
                .disabled(submitting || email.isEmpty || password.isEmpty)

                if let err = errorText {
                    Text(err)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Text("Use your iPhone-app credentials.\nCreate an account on the phone first.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
            }
            .padding(.horizontal, 4)
        }
    }

    private func submit() {
        submitting = true
        errorText = nil
        Task {
            do {
                try await auth.login(email: email.trimmingCharacters(in: .whitespaces),
                                     password: password)
                // AuthStore flips `user` to non-nil; the root view rerenders.
            } catch {
                errorText = (error as? APIError)?.errorDescription ?? error.localizedDescription
            }
            submitting = false
        }
    }
}
