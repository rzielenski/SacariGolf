//
//  ContentView.swift
//  SacariGolfWatch
//
//  Root view. Three states:
//    1. Booting — initial /users/me hydrate from a saved JWT.
//    2. Logged out — show LoginView.
//    3. Logged in — show TabHome with matches + chats.
//
//  TabHome is a thin TabView with two tabs (Matches | Chats). Each tab
//  has its own NavigationStack so deep links stay scoped.
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        if auth.isBooting {
            ProgressView()
        } else if auth.isAuthenticated {
            TabHome()
        } else {
            LoginView()
        }
    }
}

struct TabHome: View {
    var body: some View {
        TabView {
            NavigationStack { MatchListView() }
                .tabItem { Label("Matches", systemImage: "flag") }
            NavigationStack { ConversationListView() }
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
        }
    }
}
