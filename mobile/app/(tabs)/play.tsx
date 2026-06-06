import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, FlatList, ActivityIndicator, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { C, F } from '../../lib/colors';
import { distMetres } from '../../lib/golfMath';
import { Course, Teebox } from '../../types';
import { Divider } from '../../components/Flourish';

// ─────────────────────────────────────────────────────────────────────────────
// Map a tee box name to its industry-standard fabric color so the picker
// reads at a glance — same mental model as the 18Birdies / Garmin tee list.
// ─────────────────────────────────────────────────────────────────────────────
function teeColor(name: string | null | undefined): string {
  const n = (name ?? '').toLowerCase();
  if (n.includes('black') || n.includes('tip') || n.includes('champ')) return '#1a1a1a';
  if (n.includes('gold') || n.includes('senior')) return '#d4af37';
  if (n.includes('blue')) return '#3268b8';
  if (n.includes('white') || n.includes("men's") || n.includes('mens')) return '#e8e2d4';
  if (n.includes('red') || n.includes('forward') || n.includes("women") || n.includes('lady')) return '#c0382b';
  if (n.includes('green') || n.includes('junior')) return '#3a7d44';
  if (n.includes('silver')) return '#bfbfbf';
  if (n.includes('purple')) return '#7d3c98';
  return C.gold;
}

const ON_SITE_M = 1500; // ~1 mile — generous so a player parked nearby still gets the hero card

type MatchType = 'solo' | 'duo' | 'squad' | 'ffa' | 'practice';
type Format = 'stroke' | 'scramble' | 'stableford' | 'match_play' | 'skins';

// Display config for the format picker. Adding a new format means: extend
// the Format union, add a row here, and (if it's a hole-by-hole format)
// add the math to backend matches.ts computeFormatPerf().
const FORMAT_CARDS: { id: Format; name: string; mark: string; desc: string; teamOnly?: boolean }[] = [
  { id: 'stroke',     name: 'Stroke Play', mark: 'STK', desc: 'Lowest gross score wins. Standard scoring used by ELO and handicap math.' },
  { id: 'stableford', name: 'Stableford',  mark: 'STB', desc: 'Modified Stableford points: eagle 5, birdie 2, par 0, bogey −1, double or worse −3. Highest points wins — perfect for casual rounds where blow-ups matter less.' },
  { id: 'match_play', name: 'Match Play',  mark: 'MP',  desc: 'Win each hole with the lowest score. Whoever wins more holes wins the match. Halved holes don\'t count.' },
  { id: 'skins',      name: 'Skins',       mark: 'SKN', desc: 'One skin per hole won. Halved holes carry the skin to the next hole, so a single great moment can pay off big.' },
  { id: 'scramble',   name: 'Scramble',    mark: 'SCR', desc: 'Everyone plays from the best shot each time. One final team score per side. Both teams must have equal players.', teamOnly: true },
];
type Step = 'type' | 'clan' | 'format' | 'join' | 'course' | 'teebox';

const TYPE_VALUES: readonly MatchType[] = ['solo', 'duo', 'squad', 'ffa', 'practice'];

export default function PlayScreen() {
  const { user } = useAuth();
  // Optional URL params drive two unified entry points into this wizard:
  //   • ?type=solo|duo|squad|practice — pre-selects the match type so
  //     the home-tab quick actions land on the right flow with one tap.
  //   • ?challenge=<userId>&challengeName=<username> — pre-selects solo,
  //     hides the type picker, and tells startMatch() to send a match
  //     invite to that user the moment the match is created. This is what
  //     the Social → Friends → Challenge button uses — same wizard as
  //     a normal solo match, just with an invite tagged on at the end.
  const params = useLocalSearchParams<{
    type?: string;
    challenge?: string;
    challengeName?: string;
  }>();
  const challengeUserId = typeof params.challenge === 'string' ? params.challenge : null;
  const challengeUsername = typeof params.challengeName === 'string' ? params.challengeName : null;
  const [step, setStep] = useState<Step>('type');
  const [joinId, setJoinId] = useState('');
  const [joining, setJoining] = useState(false);
  const [matchType, setMatchType] = useState<MatchType>('solo');
  // Active-match count for the "Resume Round" banner at the top of the
  // type step. Cheap one-shot fetch on mount; the banner just routes the
  // player to /resume (or straight into the only active match) so they
  // can't accidentally start a second round while one's still open.
  const [resumeCount, setResumeCount] = useState(0);
  const [singleResumeId, setSingleResumeId] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const list = await api.matches.list();
        const actives = (Array.isArray(list) ? list : []).filter((m: any) => !m.completed && !m.cancelled);
        setResumeCount(actives.length);
        setSingleResumeId(actives.length === 1 ? actives[0].match_id : null);
      } catch { /* silent — banner just stays hidden */ }
    })();
  }, []);
  const [numHoles, setNumHoles] = useState<9 | 18>(18);
  // Front vs back is asked AFTER the user picks 9 holes — only meaningful
  // when playing a 9-hole subset of an 18-hole teebox.
  const [holesSubset, setHolesSubset] = useState<'front' | 'back'>('front');
  const [format, setFormat] = useState<Format>('stroke');
  const [selectedClanId, setSelectedClanId] = useState<string | null>(null);
  const [myclans, setMyClans] = useState<any[]>([]);
  const [loadingClans, setLoadingClans] = useState(false);
  const [query, setQuery] = useState('');
  const [courses, setCourses] = useState<Course[]>([]);
  const [nearbyCourses, setNearbyCourses] = useState<Course[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [searching, setSearching] = useState(false);
  const [courseDetails, setCourseDetails] = useState<Course | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [creating, setCreating] = useState(false);
  // Recent courses + last-used teebox per course, derived from the user's
  // recent_rounds. Lets us pin the most familiar courses to the top of the
  // course picker (and badge the matching tee on the teebox screen).
  const [recentCourses, setRecentCourses] = useState<{
    course_id: string;
    course_name: string;
    city?: string | null;
    state?: string | null;
    teebox_id?: string | null;
    teebox_name?: string | null;
    last_played_at?: string;
  }[]>([]);
  // Current GPS position — used by the course step to find an "on-site" course.
  const [userPos, setUserPos] = useState<{ lat: number; lng: number } | null>(null);

  // Pull recent rounds once the user is loaded, so the course step can show a
  // pinned home course + recent-courses section without an extra round-trip.
  useEffect(() => {
    if (!user?.user_id) return;
    let cancelled = false;
    api.users.get(user.user_id)
      .then((profile) => {
        if (cancelled || !profile?.recent_rounds) return;
        const seen = new Set<string>();
        const list: typeof recentCourses = [];
        for (const r of profile.recent_rounds) {
          if (!r.course_id || seen.has(r.course_id)) continue;
          seen.add(r.course_id);
          list.push({
            course_id: r.course_id,
            course_name: r.course_name ?? 'Unknown',
            teebox_id: r.teebox_id,
            teebox_name: r.teebox_name,
            last_played_at: r.created_at,
          });
        }
        setRecentCourses(list.slice(0, 5));
      })
      .catch(() => { /* non-fatal — picker still works without recents */ });
    return () => { cancelled = true; };
  }, [user?.user_id]);

  // Apply URL-param defaults whenever the player lands on this screen with
  // them set. Re-runs if a different friend is challenged without the
  // wizard being closed first. Always reset to the type step so the user
  // sees the holes/front-back picker before being whisked into the course
  // search.
  useEffect(() => {
    if (challengeUserId) {
      setMatchType('solo');
      setStep('type');
      return;
    }
    if (typeof params.type === 'string' && (TYPE_VALUES as readonly string[]).includes(params.type)) {
      setMatchType(params.type as MatchType);
      setStep('type');
    }
  }, [challengeUserId, params.type]);

  // Load nearby courses once. Also stash the GPS fix so we can detect when
  // the player is physically AT one of the returned courses → "you're at X" hero.
  useEffect(() => {
    if (step !== 'course' || nearbyCourses.length > 0) return;
    (async () => {
      setLoadingNearby(true);
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setUserPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        const results = await api.courses.nearby(pos.coords.latitude, pos.coords.longitude);
        setNearbyCourses(results);
      } catch { } finally { setLoadingNearby(false); }
    })();
  }, [step]);

  // Closest nearby course within ~1 mile, or null. Memoised so the hero only
  // re-evaluates when the inputs change.
  const onSiteCourse = useMemo<Course | null>(() => {
    if (!userPos || !nearbyCourses.length) return null;
    let best: Course | null = null;
    let bestDist = Infinity;
    for (const c of nearbyCourses) {
      if (c.latitude == null || c.longitude == null) continue;
      const d = distMetres(userPos.lat, userPos.lng, c.latitude, c.longitude);
      if (d < bestDist && d <= ON_SITE_M) { best = c; bestDist = d; }
    }
    return best;
  }, [userPos, nearbyCourses]);

  // Home course id (when set) for pinning at the top of the course picker.
  const homeCourseId = (user as any)?.home_course_id ?? null;
  const homeCourseStub: Course | null = homeCourseId
    ? {
        course_id: homeCourseId,
        course_name: (user as any)?.home_course_name ?? 'Home Course',
        club_name: null,
        city: (user as any)?.home_course_city ?? null,
        state: (user as any)?.home_course_state ?? null,
        country: null,
        latitude: (user as any)?.home_course_lat ?? null,
        longitude: (user as any)?.home_course_lng ?? null,
      }
    : null;

  // Load clans when clan step becomes active
  useEffect(() => {
    if (step !== 'clan') return;
    setLoadingClans(true);
    api.clans.mine()
      .then((all) => {
        const filtered = matchType === 'duo'
          ? all.filter((c: any) => c.clan_mode === 'duo' && c.member_count === 2)
          : all.filter((c: any) => c.clan_mode === 'squad' && c.role === 'leader' && c.member_count >= 3);
        setMyClans(filtered);
      })
      .catch(() => { })
      .finally(() => setLoadingClans(false));
  }, [step, matchType]);

  const handleJoinById = async () => {
    if (!joinId.trim()) { Alert.alert('Enter a Match ID'); return; }
    setJoining(true);
    try {
      const match = await api.matches.get(joinId.trim());
      if (match.completed) { Alert.alert('Match already completed'); return; }
      await api.matches.join(joinId.trim(), {});
      // Push (not replace) — the wizard lives inside the (tabs) group, and
      // a replace would pop the entire tabs subtree off the root stack.
      router.push(`/match/${joinId.trim()}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setJoining(false); }
  };

  const searchCourses = useCallback(async (q: string) => {
    setQuery(q);
    if (q.length < 2) { setCourses([]); return; }
    setSearching(true);
    try {
      const results = await api.courses.search(q);
      setCourses(Array.isArray(results) ? results : []);
    } catch { } finally { setSearching(false); }
  }, []);

  const selectCourse = async (course: Course) => {
    setLoadingDetails(true);
    try {
      const details = await api.courses.get(course.course_id);
      setCourseDetails(details);
      setStep('teebox');
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setLoadingDetails(false); }
  };

  const startMatch = async (teebox: Teebox) => {
    setCreating(true);
    try {
      // Only relevant when playing 9 holes on an 18-hole teebox; the backend
      // ignores it for 18-hole rounds.
      const subsetForReq: 'front' | 'back' | 'full' =
        numHoles === 9 && (teebox.num_holes ?? 18) >= 18 ? holesSubset : 'full';
      const match = await api.matches.create({
        matchType,
        isPractice: matchType === 'practice',
        teeboxId: teebox.teebox_id,
        clanId: selectedClanId ?? undefined,
        // Practice ignores format (no ELO), team modes get their picked format,
        // solo can pick stableford / match_play / skins for non-stroke ranked play.
        format: matchType === 'practice' ? 'stroke' : format,
        numHoles,
        holesSubset: subsetForReq,
        // Friendly default name for challenge matches so the recipient
        // sees something more descriptive than just "solo" in their
        // invite list.
        name: challengeUserId
          ? `${numHoles}-hole challenge from ${user?.username ?? 'a friend'}`
          : undefined,
        // Direct challenge: the server attaches the invite in the same
        // transaction and skips auto-pairing, so the match waits for this
        // friend (3-day window) instead of grabbing a random opponent.
        challengeUserId: challengeUserId ?? undefined,
      });
      // Single, consistent post-creation destination for every flow:
      // the match lobby. From there the player can tap "Start Scoring",
      // share the match ID, or invite more friends. Avoids the old split
      // where solo/practice jumped straight into scoring while duo/squad
      // bounced through an Alert first — both paths now feel identical.
      //
      // Use push (not replace) because we're crossing from the (tabs)
      // group into a sibling root-stack screen — replace would pop the
      // entire tabs subtree off the stack, leaving nothing to go back to.
      router.push(`/match/${match.match_id}` as any);
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally { setCreating(false); }
  };

  const goToNextStep = () => {
    if (matchType === 'duo' || matchType === 'squad') {
      setStep('clan');
    } else if (matchType === 'practice') {
      // Practice doesn't track ELO, no point picking a fancy format
      setStep('course');
    } else {
      // Solo + Arena: pick a format (Arena restricts to stroke/stableford —
      // match play and skins are inherently 1v1, scramble is team-only).
      setStep('format');
    }
  };

  // Button label for next step
  const nextStepLabel =
    matchType === 'duo' || matchType === 'squad' ? 'Select Team →' :
    matchType === 'practice' ? 'Select Course →' :
    'Choose Format →';

  // ── Type selection ────────────────────────────────────────────────────────────
  if (step === 'type') {
    return (
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Resume Round banner — visible whenever the player has any open
            match. Sits above the title so a half-finished round is the
            first thing they see when they open the Play tab. */}
        {resumeCount > 0 && (
          <TouchableOpacity
            style={styles.resumeBanner}
            onPress={() => router.push((singleResumeId
              ? `/match/${singleResumeId}`
              : '/resume') as any)}
            activeOpacity={0.85}
          >
            <View style={styles.resumeDot} />
            <View style={{ flex: 1 }}>
              <Text style={styles.resumeLabel}>
                {resumeCount > 1 ? `RESUME ROUND (${resumeCount})` : 'RESUME ROUND'}
              </Text>
              <Text style={styles.resumeSub}>
                {resumeCount > 1
                  ? 'Pick which one to continue.'
                  : 'Pick up where you left off.'}
              </Text>
            </View>
            <Text style={styles.resumeChev}>›</Text>
          </TouchableOpacity>
        )}

        <Text style={styles.title}>
          {challengeUserId ? 'Challenge a Friend' : 'Start a Round'}
        </Text>
        <Text style={styles.subtitle}>
          {challengeUserId
            ? `1v1 ranked match against ${challengeUsername ?? 'your friend'}`
            : 'Choose your match type'}
        </Text>
        <Divider style={{ marginTop: -8, marginBottom: 8 }} />

        {/* Type cards are hidden in challenge mode — the type is locked to
            solo and there's no value in showing the other options. */}
        {!challengeUserId && (['solo', 'duo', 'squad', 'ffa', 'practice'] as MatchType[]).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.typeCard, matchType === t && styles.typeCardActive]}
            onPress={() => setMatchType(t)}
          >
            <View style={styles.typeMark}>
              <Text style={[styles.typeMarkText, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? '1v1' : t === 'duo' ? '2v2' : t === 'squad' ? '4v4' : t === 'ffa' ? 'ARN' : 'PRC'}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.typeName, matchType === t && { color: C.gold }]}>
                {t === 'solo' ? 'Solo' : t === 'duo' ? 'Duo' : t === 'squad' ? 'Squad' : t === 'ffa' ? 'Arena' : 'Practice'}
              </Text>
              <Text style={styles.typeDesc}>
                {t === 'solo' ? 'Ranked 1v1 — auto-matched by ELO'
                  : t === 'duo' ? 'Ranked 2v2 — stroke play or scramble'
                  : t === 'squad' ? 'Ranked 4v4 — stroke play or scramble'
                  : t === 'ffa' ? 'Ranked free-for-all — invite up to 15 friends, lowest score wins'
                  : 'No ELO — just get the reps in'}
              </Text>
            </View>
            {matchType === t && <Text style={styles.checkmark}>✓</Text>}
          </TouchableOpacity>
        ))}

        <Text style={styles.holeLabel}>Holes</Text>
        <View style={styles.holeRow}>
          {([9, 18] as const).map((n) => (
            <TouchableOpacity
              key={n}
              style={[styles.holeBtn, numHoles === n && styles.holeBtnActive]}
              onPress={() => setNumHoles(n)}
            >
              <Text style={[styles.holeBtnText, numHoles === n && styles.holeBtnTextActive]}>{n} Holes</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Front 9 / Back 9 picker — only visible when the user picks 9. */}
        {numHoles === 9 && (
          <>
            <Text style={styles.holeLabel}>Which 9?</Text>
            <View style={styles.holeRow}>
              {(['front', 'back'] as const).map((side) => (
                <TouchableOpacity
                  key={side}
                  style={[styles.holeBtn, holesSubset === side && styles.holeBtnActive]}
                  onPress={() => setHolesSubset(side)}
                >
                  <Text style={[styles.holeBtnText, holesSubset === side && styles.holeBtnTextActive]}>
                    {side === 'front' ? 'Front 9' : 'Back 9'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        <TouchableOpacity style={styles.nextBtn} onPress={goToNextStep}>
          <Text style={styles.nextBtnText}>{nextStepLabel}</Text>
        </TouchableOpacity>

        {/* Join-by-ID is irrelevant when this screen is the challenge flow —
            you already know who you're playing against. */}
        {!challengeUserId && (
          <>
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>or</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity style={styles.joinMatchBtn} onPress={() => setStep('join')}>
              <Text style={styles.joinMatchText}>Join Match by ID</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    );
  }

  // ── Clan selection ────────────────────────────────────────────────────────────
  if (step === 'clan') {
    return (
      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep('type')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>
          {matchType === 'duo' ? 'Pick Your Duo' : 'Pick Your Squad'}
        </Text>
        <Text style={styles.subtitle}>
          {matchType === 'duo'
            ? 'Your partner will be notified and must accept within 24 hours'
            : 'All squad members will be notified. Only leaders can start squad matches.'}
        </Text>

        {loadingClans
          ? <ActivityIndicator color={C.gold} style={{ marginTop: 40 }} />
          : myclans.length === 0
            ? (
              <View style={styles.emptyBox}>
                <Text style={styles.emptyText}>
                  {matchType === 'duo'
                    ? 'No eligible duos'
                    : 'No eligible squads'}
                </Text>
                <Text style={styles.emptySub}>
                  {matchType === 'duo'
                    ? 'Your duo must have both members before starting a match'
                    : 'Your squad needs at least 3 members and you must be the leader'}
                </Text>
              </View>
            )
            : myclans.map((c) => (
              <TouchableOpacity
                key={c.clan_id}
                style={[styles.clanCard, selectedClanId === c.clan_id && styles.clanCardActive]}
                onPress={() => setSelectedClanId(c.clan_id)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.clanName, selectedClanId === c.clan_id && { color: C.gold }]}>{c.name}</Text>
                  <Text style={styles.clanMeta}>{c.clan_mode.toUpperCase()} · {c.member_count}/{c.max_players} members · {c.elo} ELO</Text>
                </View>
                {selectedClanId === c.clan_id && <Text style={{ color: C.gold, fontSize: 18 }}>✓</Text>}
              </TouchableOpacity>
            ))
        }

        {selectedClanId && (
          <TouchableOpacity style={[styles.nextBtn, { marginTop: 20 }]} onPress={() => setStep('format')}>
            <Text style={styles.nextBtnText}>Choose Format →</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    );
  }

  // ── Format selection ──────────────────────────────────────────────────────────
  if (step === 'format') {
    const isTeam = matchType === 'duo' || matchType === 'squad';
    const isFFA = matchType === 'ffa';
    // Solo / practice players don't see scramble (team-only). Arena hides
    // scramble too AND hides match_play / skins, which are inherently 1v1
    // and don't generalise to N-player free-for-all.
    const visibleCards = FORMAT_CARDS.filter((c) => {
      if (c.teamOnly) return isTeam;
      if (isFFA && (c.id === 'match_play' || c.id === 'skins')) return false;
      return true;
    });
    return (
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep(isTeam ? 'clan' : 'type')}>
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Choose Format</Text>
        <Text style={styles.subtitle}>{isTeam ? 'How will your team play?' : 'Pick the scoring style for this round.'}</Text>

        {visibleCards.map((card) => (
          <TouchableOpacity
            key={card.id}
            style={[styles.formatCard, format === card.id && styles.formatCardActive]}
            onPress={() => setFormat(card.id)}
            activeOpacity={0.85}
          >
            <View style={styles.formatIcon}>
              <Text style={[styles.formatIconText, format === card.id && { color: C.gold }]}>{card.mark}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.formatName, format === card.id && { color: C.gold }]}>{card.name}</Text>
              <Text style={styles.formatDesc}>{card.desc}</Text>
            </View>
            {format === card.id && <Text style={{ color: C.gold, fontSize: 20 }}>✓</Text>}
          </TouchableOpacity>
        ))}

        <TouchableOpacity style={[styles.nextBtn, { marginTop: 20 }]} onPress={() => setStep('course')}>
          <Text style={styles.nextBtnText}>Select Course →</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Join by ID ────────────────────────────────────────────────────────────────
  if (step === 'join') {
    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scrollContainer}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <TouchableOpacity style={styles.backBtn} onPress={() => setStep('type')}>
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Join a Match</Text>
          <Text style={styles.subtitle}>Enter the Match ID shared by your friend</Text>
          <TextInput
            style={styles.searchInput}
            value={joinId}
            onChangeText={setJoinId}
            placeholder="Paste Match ID here..."
            placeholderTextColor={C.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.nextBtn, joining && { opacity: 0.6 }]}
            onPress={handleJoinById}
            disabled={joining}
          >
            {joining ? <ActivityIndicator color="#000" /> : <Text style={styles.nextBtnText}>Join Match →</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Course search ─────────────────────────────────────────────────────────────
  if (step === 'course') {
    // Filter out duplicate IDs across sections so a course never appears twice.
    const pinnedIds = new Set<string>();
    if (onSiteCourse) pinnedIds.add(onSiteCourse.course_id);
    if (homeCourseStub && !pinnedIds.has(homeCourseStub.course_id)) pinnedIds.add(homeCourseStub.course_id);
    const recentsToShow = recentCourses.filter((c) => !pinnedIds.has(c.course_id));
    recentsToShow.forEach((c) => pinnedIds.add(c.course_id));
    const nearbyToShow = nearbyCourses.filter((c) => !pinnedIds.has(c.course_id));

    return (
      <KeyboardAvoidingView
        style={{ flex: 1, backgroundColor: C.bg }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <View style={styles.container}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setStep(matchType === 'duo' || matchType === 'squad' ? 'format' : 'type')} >
          <Text style={styles.backBtnText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Where to Play</Text>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={searchCourses}
          placeholder="Search course, club, city..."
          placeholderTextColor={C.textMuted}
        />
        {(searching || loadingDetails) && <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />}

        {/* SEARCH MODE — flat list of search results */}
        {query.length >= 2 && !searching && (
          <FlatList
            data={courses}
            keyExtractor={(c) => c.course_id}
            renderItem={({ item }) => <CourseRow course={item} onPress={() => selectCourse(item)} />}
            ListEmptyComponent={<Text style={styles.emptyMsg}>No courses match "{query}"</Text>}
            style={{ marginTop: 4 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />
        )}

        {/* DEFAULT MODE — on-site hero + home + recents + nearby */}
        {query.length < 2 && (
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }}>
            {/* "You're at X" hero — auto-detected from GPS */}
            {onSiteCourse && (
              <TouchableOpacity
                style={styles.onSiteHero}
                onPress={() => selectCourse(onSiteCourse)}
                activeOpacity={0.85}
              >
                <Text style={styles.onSiteLabel}>YOU'RE AT</Text>
                <Text style={styles.onSiteName}>{onSiteCourse.course_name}</Text>
                {(onSiteCourse.city || onSiteCourse.state) && (
                  <Text style={styles.onSiteLoc}>
                    {[onSiteCourse.city, onSiteCourse.state].filter(Boolean).join(', ')}
                  </Text>
                )}
                <Text style={styles.onSiteCta}>Tap to start →</Text>
              </TouchableOpacity>
            )}

            {/* Home course — pinned card */}
            {homeCourseStub && homeCourseStub.course_id !== onSiteCourse?.course_id && (
              <>
                <Text style={styles.sectionLabel}>★ Home Course</Text>
                <CourseRow course={homeCourseStub} onPress={() => selectCourse(homeCourseStub)} accent />
              </>
            )}

            {/* Recently played */}
            {recentsToShow.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Recently Played</Text>
                {recentsToShow.map((rc) => (
                  <CourseRow
                    key={rc.course_id}
                    course={{
                      course_id: rc.course_id,
                      course_name: rc.course_name,
                      club_name: null,
                      city: rc.city ?? null,
                      state: rc.state ?? null,
                      country: null,
                      latitude: null, longitude: null,
                    }}
                    sub={rc.teebox_name ? `Last: ${rc.teebox_name} tees` : undefined}
                    onPress={() => selectCourse({
                      course_id: rc.course_id,
                      course_name: rc.course_name,
                      club_name: null,
                      city: rc.city ?? null,
                      state: rc.state ?? null,
                      country: null,
                      latitude: null, longitude: null,
                    })}
                  />
                ))}
              </>
            )}

            {/* Nearby (whatever's left) */}
            {loadingNearby ? (
              <ActivityIndicator color={C.gold} style={{ marginTop: 20 }} />
            ) : nearbyToShow.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Nearby</Text>
                {nearbyToShow.map((c) => (
                  <CourseRow key={c.course_id} course={c} onPress={() => selectCourse(c)} />
                ))}
              </>
            ) : null}

            {/* Empty state — first-time user */}
            {!onSiteCourse && !homeCourseStub && recentsToShow.length === 0 && nearbyToShow.length === 0 && !loadingNearby && (
              <Text style={styles.emptyMsg}>Search for a course above, or set your home course in the Profile tab.</Text>
            )}
          </ScrollView>
        )}
      </View>
      </KeyboardAvoidingView>
    );
  }

  // ── Teebox selection ──────────────────────────────────────────────────────────
  // Find the user's last-played teebox AT THIS COURSE so we can highlight the
  // matching card. This is one of the highest-friction parts of every other
  // golf app — for a regular at one course, it should be a single tap.
  const lastTeeboxIdAtThisCourse = recentCourses.find(
    (rc) => rc.course_id === courseDetails?.course_id,
  )?.teebox_id;
  // Sort: last-played tee first, then everything else in the order returned
  // by the backend (which is `total_yards DESC` — black/championship up top).
  // Teeboxes the user can pick at this hole count:
  //   • If the teebox covers ≥ numHoles, it's a normal pick.
  //   • If the user picked 18 but the teebox is 9-hole, allow it — the
  //     scoring screen will duplicate the front 9 to fill out a full 18
  //     ("play these 9 holes twice"). Particularly useful for short courses
  //     and executive layouts where every teebox tops out at 9.
  const filteredTees = (courseDetails?.teeboxes ?? []).filter((t) =>
    t.num_holes >= numHoles || (numHoles === 18 && t.num_holes === 9)
  );
  const orderedTees = lastTeeboxIdAtThisCourse
    ? [
        ...filteredTees.filter((t) => t.teebox_id === lastTeeboxIdAtThisCourse),
        ...filteredTees.filter((t) => t.teebox_id !== lastTeeboxIdAtThisCourse),
      ]
    : filteredTees;

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backBtn} onPress={() => { setStep('course'); setCourseDetails(null); }}>
        <Text style={styles.backBtnText}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>{courseDetails?.course_name}</Text>
      <Text style={styles.subtitle}>
        Pick your tees — {numHoles === 9
          ? `${holesSubset === 'back' ? 'Back' : 'Front'} 9`
          : '18 holes'}
      </Text>
      <ScrollView>
        {orderedTees.length === 0 && (
          <Text style={styles.emptyMsg}>
            No tees with {numHoles} holes at this course. Pick a different course or change hole count.
          </Text>
        )}
        {orderedTees.map((t) => {
          const color = teeColor(t.name);
          const isLast = t.teebox_id === lastTeeboxIdAtThisCourse;
          return (
            <TouchableOpacity
              key={t.teebox_id}
              style={[styles.teeboxCardV2, isLast && styles.teeboxCardLast]}
              onPress={() => startMatch(t)}
              disabled={creating}
              activeOpacity={0.85}
            >
              {/* Vertical color stripe — instant tee identification */}
              <View style={[styles.teeStripe, { backgroundColor: color }]} />
              <View style={styles.teeboxLeft}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={styles.teeboxName}>{t.name}</Text>
                  {isLast && (
                    <View style={styles.lastBadge}>
                      <Text style={styles.lastBadgeText}>LAST PLAYED</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.teeboxMeta}>
                  Par {t.par} · {t.total_yards?.toLocaleString() ?? '—'} yds · {t.num_holes} holes
                  {numHoles === 18 && t.num_holes === 9 ? ' · plays twice for 18' : ''}
                </Text>
              </View>
              <View style={styles.teeboxRight}>
                <Text style={styles.teeboxRating}>{t.course_rating ?? '—'} / {t.slope_rating ?? '—'}</Text>
                <Text style={styles.teeboxRatingLabel}>RATING / SLOPE</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        {creating && (
          <View style={{ alignItems: 'center', marginTop: 20 }}>
            <ActivityIndicator color={C.gold} />
            <Text style={{ color: C.textMuted, marginTop: 8 }}>Creating match...</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function CourseRow({
  course,
  onPress,
  accent,
  sub,
}: {
  course: Course;
  onPress: () => void;
  accent?: boolean;
  sub?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.courseCard, accent && styles.courseCardAccent]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.courseName}>{course.course_name}</Text>
        {course.club_name && course.club_name !== course.course_name && (
          <Text style={styles.clubName}>{course.club_name}</Text>
        )}
        {(course.city || course.state) && (
          <Text style={styles.courseLocation}>
            {[course.city, course.state].filter(Boolean).join(', ')}
          </Text>
        )}
        {sub ? <Text style={styles.courseSub}>{sub}</Text> : null}
      </View>
      <Text style={styles.courseChev}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, padding: 20, paddingTop: 60 },
  // Scrollable variant for steps with stacked content (type / clan / join /
  // course). Style applies to the ScrollView itself; `scrollContent` is the
  // inner padding so child layout matches the static container. `paddingBottom`
  // is generous so the last button clears the home-indicator + keyboard.
  scrollContainer: { flex: 1, backgroundColor: C.bg },
  scrollContent: { padding: 20, paddingTop: 60, paddingBottom: 80 },
  title: { color: C.text, fontSize: 26, fontWeight: '900', marginBottom: 4 },
  subtitle: { color: C.textMuted, fontSize: 14, marginBottom: 24 },

  resumeBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: C.gold + '18',
    borderColor: C.gold, borderWidth: 1,
    borderRadius: 10, padding: 14,
    marginBottom: 18,
  },
  resumeDot: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: C.gold,
  },
  resumeLabel: {
    color: C.gold, fontSize: 13, fontWeight: '900', letterSpacing: 1.2,
  },
  resumeSub: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  resumeChev: { color: C.gold, fontSize: 24, fontWeight: '300', paddingHorizontal: 4 },
  backBtn: { marginBottom: 12 },
  backBtnText: { color: C.gold, fontSize: 16 },

  typeCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  typeCardActive: { borderColor: C.gold },
  typeMark: { width: 44, height: 44, borderRadius: 4, borderWidth: 1, borderColor: C.border, justifyContent: 'center', alignItems: 'center' },
  typeMarkText: { fontFamily: F.serif, fontSize: 13, fontWeight: '700', color: C.textMuted, letterSpacing: 1 },
  typeName: { color: C.text, fontWeight: '700', fontSize: 15, letterSpacing: 0.3 },
  typeDesc: { color: C.textMuted, fontSize: 12, marginTop: 3 },
  checkmark: { color: C.gold, fontSize: 18, fontWeight: '900' },

  holeLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 16, marginBottom: 8 },
  holeRow: { flexDirection: 'row', gap: 10 },
  holeBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: C.card, borderWidth: 2, borderColor: C.border },
  holeBtnActive: { borderColor: C.gold, backgroundColor: C.gold + '18' },
  holeBtnText: { color: C.textMuted, fontWeight: '700', fontSize: 15 },
  holeBtnTextActive: { color: C.gold },

  nextBtn: { backgroundColor: C.gold, borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 12 },
  nextBtnText: { color: '#000', fontWeight: '800', fontSize: 16 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 10, marginVertical: 16 },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.border },
  dividerText: { color: C.textMuted, fontSize: 13 },
  joinMatchBtn: { borderRadius: 14, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  joinMatchText: { color: C.textMuted, fontWeight: '600', fontSize: 15 },

  clanCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'center',
    marginBottom: 10, borderWidth: 1, borderColor: C.border,
  },
  clanCardActive: { borderColor: C.gold },
  clanName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clanMeta: { color: C.textMuted, fontSize: 12, marginTop: 3 },

  formatCard: {
    backgroundColor: C.card, borderRadius: 6, padding: 16,
    flexDirection: 'row', alignItems: 'flex-start', gap: 14,
    marginBottom: 12, borderWidth: 1, borderColor: C.border,
  },
  formatCardActive: { borderColor: C.gold },
  formatIcon: { width: 48, height: 48, borderRadius: 4, borderWidth: 1, borderColor: C.border, justifyContent: 'center', alignItems: 'center', marginTop: 2 },
  formatIconText: { fontFamily: F.serif, fontSize: 12, fontWeight: '700', color: C.textMuted, letterSpacing: 1 },
  formatName: { color: C.text, fontWeight: '700', fontSize: 15, marginBottom: 4 },
  formatDesc: { color: C.textMuted, fontSize: 12, lineHeight: 18 },

  emptyBox: { alignItems: 'center', paddingTop: 50 },
  emptyText: { color: C.text, fontWeight: '700', fontSize: 16, textAlign: 'center' },
  emptySub: { color: C.textMuted, fontSize: 13, marginTop: 8, textAlign: 'center' },

  searchInput: {
    backgroundColor: C.card, color: C.text, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  nearbyLabel: { color: C.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 12, marginBottom: 8 },
  courseCard: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 8, borderWidth: 1, borderColor: C.border },
  courseName: { color: C.text, fontWeight: '700', fontSize: 15 },
  clubName: { color: C.textMuted, fontSize: 12, marginTop: 2 },
  courseLocation: { color: C.gold, fontSize: 12, marginTop: 4 },

  teeboxCard: {
    backgroundColor: C.card, borderRadius: 14, padding: 18, marginBottom: 10,
    flexDirection: 'row', justifyContent: 'space-between', borderWidth: 1, borderColor: C.border,
  },
  teeboxLeft: { flex: 1 },
  teeboxName: { color: C.text, fontWeight: '800', fontSize: 17 },
  teeboxMeta: { color: C.textMuted, fontSize: 12, marginTop: 4 },
  teeboxRight: { alignItems: 'flex-end' },
  teeboxRating: { color: C.gold, fontWeight: '700', fontSize: 13 },
  teeboxRatingLabel: { color: C.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: 2 },
  teeboxSlope: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  // V2 teebox card with the colored fabric stripe + last-played badge.
  teeboxCardV2: {
    backgroundColor: C.card, borderRadius: 12, marginBottom: 10,
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: C.border, overflow: 'hidden',
  },
  teeboxCardLast: { borderColor: C.gold },
  teeStripe: { width: 8, alignSelf: 'stretch' },
  lastBadge: {
    backgroundColor: C.gold + '33', borderRadius: 4,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: C.gold,
  },
  lastBadgeText: { color: C.gold, fontSize: 9, fontWeight: '900', letterSpacing: 1 },

  // Course-picker enhancements (on-site hero, section labels, accent card)
  onSiteHero: {
    backgroundColor: C.gold + '18', borderRadius: 16, padding: 18,
    marginBottom: 16, borderWidth: 2, borderColor: C.gold,
  },
  onSiteLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 2, marginBottom: 4 },
  onSiteName: { color: C.text, fontSize: 22, fontWeight: '900', fontFamily: F.serif },
  onSiteLoc: { color: C.textMuted, fontSize: 13, marginTop: 4 },
  onSiteCta: { color: C.gold, fontSize: 13, fontWeight: '700', marginTop: 10 },
  sectionLabel: {
    color: C.textMuted, fontSize: 11, fontWeight: '700',
    letterSpacing: 1.5, textTransform: 'uppercase',
    marginTop: 14, marginBottom: 8,
  },
  courseCardAccent: { borderColor: C.gold + '88', backgroundColor: C.gold + '0a' },
  courseSub: { color: C.gold, fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  courseChev: { color: C.textDim, fontSize: 22, marginLeft: 8 },
  emptyMsg: { color: C.textMuted, fontSize: 13, textAlign: 'center', marginTop: 24, paddingHorizontal: 12 },
});
