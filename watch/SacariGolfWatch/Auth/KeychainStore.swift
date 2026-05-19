//
//  KeychainStore.swift
//  SacariGolfWatch
//
//  Secure JWT storage. Wraps the iOS/watchOS keychain into a single
//  property with sync get/set, so APIClient can read it on every
//  request without worrying about async plumbing.
//
//  Why keychain and not UserDefaults: UserDefaults is plaintext on disk
//  and survives uninstall in some cases. A long-lived auth token must
//  not sit there. Keychain is encrypted and tied to the app's signing
//  identity.
//

import Foundation
import Security

final class KeychainStore {
    static let shared = KeychainStore()

    private let service = "com.sacarigolf.watch.auth"
    private let account = "jwt"

    /// Read/write the JWT. Setting to nil deletes the item.
    var token: String? {
        get { read() }
        set {
            if let v = newValue { write(v) }
            else { delete() }
        }
    }

    private func read() -> String? {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
            kSecReturnData as String:   true,
            kSecMatchLimit as String:   kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func write(_ value: String) {
        let data = Data(value.utf8)
        // Upsert pattern: try update first, fall back to add. Avoids the
        // "item already exists" duplicate-key error on re-login.
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
        ]
        let upd: [String: Any] = [ kSecValueData as String: data ]
        let updateStatus = SecItemUpdate(q as CFDictionary, upd as CFDictionary)
        if updateStatus == errSecItemNotFound {
            var add = q
            add[kSecValueData as String] = data
            // Accessible after first unlock — the watch needs to use the
            // token in background contexts (e.g. periodic chat fetch
            // while wrist is down).
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    private func delete() {
        let q: [String: Any] = [
            kSecClass as String:        kSecClassGenericPassword,
            kSecAttrService as String:  service,
            kSecAttrAccount as String:  account,
        ]
        SecItemDelete(q as CFDictionary)
    }
}
