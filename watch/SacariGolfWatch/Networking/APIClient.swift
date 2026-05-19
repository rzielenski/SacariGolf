//
//  APIClient.swift
//  SacariGolfWatch
//
//  Single typed HTTP wrapper around the backend. Pattern mirrors the
//  iOS app's `mobile/lib/api.ts` so endpoints map 1:1 and shapes don't
//  drift between clients.
//
//  Conventions:
//    • All endpoints are async/await and throw APIError on failure.
//    • JWT is read from KeychainStore on every request. Logout = clearing
//      the keychain entry.
//    • 401 responses clear the token and notify AuthStore so the user
//      is bounced back to login.
//

import Foundation

// IMPORTANT: replace with your Railway URL. Match what the iOS app uses
// in mobile/lib/api.ts — typically a single source of truth, NOT per
// build configuration unless you actively run a staging env.
let API_BASE = "https://your-backend.up.railway.app"

enum APIError: Error, LocalizedError {
    case invalidURL
    case notAuthenticated
    case http(Int, String?)
    case decoding(String)
    case offline

    var errorDescription: String? {
        switch self {
        case .invalidURL:           return "Bad URL"
        case .notAuthenticated:     return "Not signed in"
        case .http(let code, let msg): return msg ?? "Server error (\(code))"
        case .decoding(let m):      return "Couldn't read server response: \(m)"
        case .offline:              return "No internet connection"
        }
    }
}

actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// Notified whenever a request returns 401 — the UI listens to bounce
    /// the user back to the login screen. Posted from the main actor.
    static let unauthorizedNotification = Notification.Name("APIClient.unauthorized")

    init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.waitsForConnectivity = true
        self.session = URLSession(configuration: cfg)
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    // ─── Auth ──────────────────────────────────────────────────────

    func login(email: String, password: String) async throws -> LoginResponse {
        try await post("/auth/login",
                       body: LoginRequest(email: email, password: password),
                       auth: false)
    }

    func me() async throws -> User {
        try await get("/users/me")
    }

    // ─── Matches ──────────────────────────────────────────────────

    func matches() async throws -> [MatchSummary] {
        try await get("/matches")
    }

    /// Full detail for a single match — includes the player roster with
    /// teebox_id + course_id we need to hydrate the scoring screen.
    func match(id: String) async throws -> MatchDetail {
        try await get("/matches/\(id)")
    }

    func course(id: String) async throws -> Course {
        try await get("/courses/\(id)")
    }

    func submitScores(matchId: String, body: SubmitScoresRequest) async throws {
        let _: EmptyResponse = try await post("/matches/\(matchId)/scores", body: body)
    }

    func saveShots(matchId: String, holeNum: Int, body: SaveShotsRequest) async throws {
        let _: EmptyResponse = try await put("/matches/\(matchId)/shots/\(holeNum)", body: body)
    }

    // ─── Weather (for plays-like) ────────────────────────────────

    func weather(lat: Double, lng: Double) async throws -> Weather {
        let q = "lat=\(lat)&lng=\(lng)"
        return try await get("/weather?\(q)")
    }

    // ─── Chat ─────────────────────────────────────────────────────

    func conversations() async throws -> [Conversation] {
        try await get("/messages/conversations")
    }

    func dm(userId: String) async throws -> [DirectMessage] {
        try await get("/dm/\(userId)")
    }

    func sendDM(userId: String, body: String) async throws -> DirectMessage {
        try await post("/dm/\(userId)", body: SendDMRequest(body: body))
    }

    func friends() async throws -> [Friend] {
        try await get("/users/me/friends")
    }

    // ─── HTTP plumbing ────────────────────────────────────────────

    private func get<T: Decodable>(_ path: String, auth: Bool = true) async throws -> T {
        try await request(path: path, method: "GET", body: Optional<EmptyResponse>.none, auth: auth)
    }

    private func post<B: Encodable, T: Decodable>(_ path: String, body: B, auth: Bool = true) async throws -> T {
        try await request(path: path, method: "POST", body: body, auth: auth)
    }

    private func put<B: Encodable, T: Decodable>(_ path: String, body: B, auth: Bool = true) async throws -> T {
        try await request(path: path, method: "PUT", body: body, auth: auth)
    }

    private func request<B: Encodable, T: Decodable>(
        path: String,
        method: String,
        body: B?,
        auth: Bool
    ) async throws -> T {
        guard let url = URL(string: API_BASE + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")

        if auth {
            guard let token = KeychainStore.shared.token else {
                throw APIError.notAuthenticated
            }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = body {
            req.httpBody = try encoder.encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            // Network-layer failure (offline, DNS, TLS). Bubble up as
            // an offline error so the UI can show "no internet" instead
            // of a confusing "Decoder couldn't parse".
            throw APIError.offline
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.http(0, nil)
        }
        if http.statusCode == 401 {
            // Token's gone bad — clear it and signal the UI.
            KeychainStore.shared.token = nil
            await MainActor.run {
                NotificationCenter.default.post(name: APIClient.unauthorizedNotification, object: nil)
            }
            throw APIError.notAuthenticated
        }
        if !(200..<300).contains(http.statusCode) {
            // Try to pull a friendly { error: "..." } message off the body.
            let msg = (try? decoder.decode(ErrorBody.self, from: data))?.error
            throw APIError.http(http.statusCode, msg)
        }

        // Special case — endpoints with no useful body (POST /scores) call
        // through with T = EmptyResponse and we accept any 2xx as success.
        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error))
        }
    }
}

/// Sentinel for "this endpoint returns 2xx and we don't care what's in
/// the body." Codable conformance lets it slot into the same generic
/// pipeline as real response types.
struct EmptyResponse: Codable {}

/// Shape of the server's error responses — `{ error: "human readable" }`.
struct ErrorBody: Codable {
    let error: String?
}
