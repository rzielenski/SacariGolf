/**
 * Theme song player — a module-level singleton that owns the playback Sound
 * across screens so the music DOES NOT cut out when the animation that
 * triggered it (MatchFoundIntro, HoleScoreCelebration, etc) dismisses.
 *
 * Before this, every component held its own Audio.Sound and called
 * stopAsync + unloadAsync on its cleanup effect. The intro modal closes
 * ~2.5 seconds after the theme starts, so 28 seconds of iTunes preview
 * never got heard. Now the modal hands off to play() and walks away; the
 * Sound self-unloads on didJustFinish.
 *
 * Volume mode: when the user has theme_song_max_volume = TRUE, we set
 * playsInSilentModeIOS so the audio plays loud even with the silent
 * switch flipped, AND set the Sound's own volume to 1.0. iOS does not
 * give third-party apps programmatic control of SYSTEM volume — this is
 * the maximum loudness an App-Store-compliant app can produce.
 */

import { Audio } from 'expo-av';

let currentSound: Audio.Sound | null = null;
let currentToken = 0;
let maxVolumeMode = false;

/** Sync the player's volume mode with the user's saved preference. Called
 *  from AuthProvider / Settings when the toggle changes so the NEXT play()
 *  picks the new behaviour up immediately. */
export function setThemeMaxVolume(enabled: boolean) {
  maxVolumeMode = !!enabled;
}

/** Start (or restart) the theme song. Stops any track currently playing
 *  first, then loads the new URI. Resolves once playback has actually
 *  started — callers can `await` it if they need to time something against
 *  the first beat, but most fire-and-forget. */
export async function play(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  const token = ++currentToken;

  // Tear down anything already playing so we don't double-stack tracks.
  if (currentSound) {
    try { await currentSound.stopAsync(); } catch { /* already stopped */ }
    try { await currentSound.unloadAsync(); } catch { /* already unloaded */ }
    currentSound = null;
  }

  // Audio session: silent-switch override + appropriate interruption mode
  // for music. playsInSilentModeIOS depends on the user's "boost theme
  // volume" toggle — when off, we respect the physical silent switch.
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: maxVolumeMode,
      allowsRecordingIOS: false,
      staysActiveInBackground: false,
    });
  } catch { /* non-fatal: keep playing in default audio mode */ }

  let sound: Audio.Sound;
  try {
    const created = await Audio.Sound.createAsync(
      { uri },
      { shouldPlay: true, volume: 1.0 },
    );
    sound = created.sound;
  } catch {
    // Likely network — preview URLs are 30s remote files. Silent fail
    // matches the existing in-component behaviour.
    return;
  }

  // If a NEWER play() raced in while we were creating the Sound, the
  // newer call already started; drop this one.
  if (token !== currentToken) {
    try { await sound.unloadAsync(); } catch { /* ignore */ }
    return;
  }
  currentSound = sound;

  // Self-unload when the preview finishes. The intro modal is long gone
  // by this point, so without this hook the Sound would sit loaded in
  // memory until the user navigates somewhere that triggers a new play().
  sound.setOnPlaybackStatusUpdate((status) => {
    if (!status.isLoaded) return;
    if (status.didJustFinish) {
      sound.unloadAsync().catch(() => {});
      if (currentSound === sound) currentSound = null;
    }
  });
}

/** Force-stop and unload — used by Settings → Stop Preview, and by
 *  navigation flows that want to silence whatever's playing (e.g. opening
 *  a chat where another sound takes over). */
export async function stop(): Promise<void> {
  currentToken++;  // invalidate any in-flight play()
  if (!currentSound) return;
  const s = currentSound;
  currentSound = null;
  try { await s.stopAsync(); } catch { /* already stopped */ }
  try { await s.unloadAsync(); } catch { /* already unloaded */ }
}

/** True iff a Sound is currently loaded (whether or not it's actively
 *  playing right this instant). Used by Settings to show a "stop" button. */
export function isPlaying(): boolean {
  return currentSound !== null;
}
