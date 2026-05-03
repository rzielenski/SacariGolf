# Clash of Clubs — Setup Guide

## Architecture
- **mobile/** — Expo (React Native) iOS app
- **backend/** — Node.js + Express REST API
- **docker-compose.yml** — PostgreSQL database + API in Docker

---

## Step 1: Configure your local IP in the mobile app

Edit `mobile/lib/api.ts` and change `API_BASE` to your computer's local IP address:

```ts
export const API_BASE = 'http://YOUR_LOCAL_IP:3000';
```

Find your IP:
- Windows: `ipconfig` → look for IPv4 Address (e.g. `192.168.1.42`)
- Then set: `export const API_BASE = 'http://192.168.1.42:3000';`

Your phone and computer must be on the same WiFi network.

---

## Step 2: Start the backend with Docker

Make sure Docker Desktop is running, then:

```bash
docker-compose up -d
```

This starts:
- PostgreSQL on port 5432 (with schema + Potsdam NY course data pre-loaded)
- Express API on port 3000

Check it's running:
```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

---

## Step 3: Run the mobile app

```bash
cd mobile
npx expo start
```

Then:
1. Install **Expo Go** on your iPhone (App Store, free)
2. Open the camera or Expo Go app
3. Scan the QR code shown in terminal
4. App launches on your phone!

Share the QR code with your friends to let them join.

---

## Playing a match with friends

1. Each person creates an account in the app
2. One person creates a Solo or Duo match (Play tab)
3. Select a course (try "Clarkson", "Massena", "Higley")
4. Pick tee box
5. Share the Match ID with your opponent (tap "Share Match ID")
6. Opponent joins via... (join flow TBD — for now use same match ID)
7. Both players go through holes and enter scores
8. When both submit, ELO is calculated automatically

### ELO Calculation
- Uses golf Score Differential: `(Gross - Course Rating) × (113 / Slope)`
- Lower differential wins
- Chess-style ELO formula: K=32 for new players, K=24 established

---

## Courses pre-loaded near Potsdam, NY
- Clarkson University Golf Course (Potsdam)
- Higley Flow Golf Course (Colton)
- Massena Country Club
- Gouverneur Golf Course
- Ogdensburg Country Club
- St. Lawrence University (Canton)

---

## Deploying for weekend access (optional)

If you want friends to connect without being on your WiFi, deploy to Railway:

1. Sign up at railway.app (free)
2. `railway login` then `railway up` from project root
3. Update `API_BASE` in `mobile/lib/api.ts` to your Railway URL

---

## Troubleshooting

**"Network request failed"** — Check that:
- Docker is running (`docker ps`)
- Your IP in `api.ts` matches your actual local IP
- Phone and computer are on same WiFi

**"Invalid token"** — Log out and log back in

**Course holes missing** — The course may not have holes seeded yet. Try Clarkson or Massena which are fully seeded.
