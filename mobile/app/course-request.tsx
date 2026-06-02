/**
 * Course builder — three-step flow that lets a player add a course to the
 * catalog themselves rather than waiting for an admin to do it.
 *
 *   Step 1 — Basics      → name, location (GPS or manual), 9 or 18 holes,
 *                          tee sets (1..4) each with optional rating/slope.
 *   Step 2 — Holes       → per-hole par, HCP, and per-tee yardage. Running
 *                          totals + soft realism warnings inline.
 *   Step 3 — Review      → computed totals, estimated rating/slope shown
 *                          for any tee set with blank or implausible
 *                          values, server warnings echoed back, submit.
 *
 * On successful submit we offer the user a one-tap detour to the existing
 * /course/admin-pins/<id> screen so they can drop greens-coordinates while
 * the course's layout is fresh in their head. (Pins are crowdsourced and
 * last-write-wins; this just makes the "I'm at the course, may as well
 * set them now" path obvious.)
 *
 * Server contract: POST /courses (see backend/src/routes/courses.ts). The
 * server re-runs every validation we run here, fills in missing
 * rating/slope from a length heuristic, and stamps created_by_user_id so
 * an admin can audit. Verified flag stays FALSE until a human reviews.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import MapView, { Marker, Region } from 'react-native-maps';
import * as Location from 'expo-location';
import { Stack, router } from 'expo-router';
import { api } from '../lib/api';
import { C, F } from '../lib/colors';

type Step = 1 | 2 | 3;

type TeeForm = {
  id: string;
  name: string;
  gender: 'male' | 'female';
  rating: string;
  slope: string;
};

type HoleForm = {
  par: string;
  handicap: string;
  yardages: Record<string, string>; // teeId → yardage string
};

const PAR_CHOICES = [3, 4, 5, 6];

let teeIdCounter = 1;
const nextTeeId = () => `tee-${teeIdCounter++}`;

/**
 * Build a blank hole-grid for the given hole count + tee ids. Initial
 * handicap suggestion is 1..N so the user just confirms instead of
 * starting from nothing.
 */
function makeHoles(n: number, teeIds: string[]): HoleForm[] {
  return Array.from({ length: n }, (_, i) => ({
    par: '4',
    handicap: String(i + 1),
    yardages: Object.fromEntries(teeIds.map((tid) => [tid, ''])),
  }));
}

/**
 * Resize / re-tee an existing hole grid in place, preserving any par /
 * HCP / yardage the user already entered. Adding a hole appends blanks;
 * removing trims from the end. Adding a tee adds an empty column;
 * removing a tee drops that column.
 */
function reshapeHoles(prev: HoleForm[], n: number, teeIds: string[]): HoleForm[] {
  const next: HoleForm[] = [];
  for (let i = 0; i < n; i++) {
    const old = prev[i];
    const yardages: Record<string, string> = {};
    for (const tid of teeIds) {
      yardages[tid] = old?.yardages[tid] ?? '';
    }
    next.push({
      par:      old?.par      ?? '4',
      handicap: old?.handicap ?? String(i + 1),
      yardages,
    });
  }
  return next;
}

/** Same length heuristic the server uses; kept local so Step 3 can show
 *  the player what rating they'll get before they submit. Bounded to the
 *  USGA-plausible window. */
function estimateRatingSlope(par: number, totalYards: number, gender: 'male' | 'female') {
  const neutral = (gender === 'female' ? 5200 : 5800) + (par - 72) * 90;
  const rating = Math.max(55, Math.min(80, Math.round((par + (totalYards - neutral) / 220) * 10) / 10));
  const slope  = Math.max(85, Math.min(140, Math.round(113 + (totalYards - neutral) / 50)));
  return { rating, slope };
}

export default function CourseBuilderScreen() {
  const [step, setStep] = useState<Step>(1);

  // ── Step 1 form state ───────────────────────────────────────────────
  const [courseName, setCourseName] = useState('');
  const [city, setCity] = useState('');
  const [stateField, setStateField] = useState('');
  const [country, setCountry] = useState('United States');
  const [coord, setCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  // Initial map region. Seeded from the device's last-known location if we
  // already have permission, so the map opens near the user instead of
  // centered on Kansas. Falls back to a CONUS-wide framing.
  const [initialRegion, setInitialRegion] = useState<Region>({
    latitude: 39.5, longitude: -98.35,
    latitudeDelta: 30, longitudeDelta: 30,
  });
  const mapRef = useRef<MapView | null>(null);
  const [numHoles, setNumHoles] = useState<9 | 18>(18);
  const [teeForms, setTeeForms] = useState<TeeForm[]>(() => [
    { id: nextTeeId(), name: 'Standard', gender: 'male', rating: '', slope: '' },
  ]);

  // ── Step 2 form state ───────────────────────────────────────────────
  const [holes, setHoles] = useState<HoleForm[]>(() =>
    makeHoles(18, ['tee-0-initial']),  // overwritten on first step 1 → 2
  );

  // ── Submission state ───────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);

  // Seed the map's initial framing from the device's last-known location.
  // Only consults already-granted permission, so opening this screen never
  // pops a prompt on its own — the player triggers that explicitly via the
  // "Use my current location" button.
  useEffect(() => {
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted') return;
        const last = await Location.getLastKnownPositionAsync();
        if (!last) return;
        setInitialRegion({
          latitude: last.coords.latitude,
          longitude: last.coords.longitude,
          latitudeDelta: 0.5,
          longitudeDelta: 0.5,
        });
      } catch { /* permissions check failed; keep the CONUS fallback */ }
    })();
  }, []);

  // Keep the hole grid in lockstep with hole count + tee count.
  const syncHoles = (n: number, tees: TeeForm[]) => {
    setHoles((prev) => reshapeHoles(prev, n, tees.map((t) => t.id)));
  };

  const changeNumHoles = (n: 9 | 18) => {
    setNumHoles(n);
    syncHoles(n, teeForms);
  };

  const addTeeSet = () => {
    if (teeForms.length >= 4) return;
    const tee: TeeForm = { id: nextTeeId(), name: '', gender: 'male', rating: '', slope: '' };
    const next = [...teeForms, tee];
    setTeeForms(next);
    syncHoles(numHoles, next);
  };

  const removeTeeSet = (id: string) => {
    if (teeForms.length <= 1) return;
    const next = teeForms.filter((t) => t.id !== id);
    setTeeForms(next);
    syncHoles(numHoles, next);
  };

  const updateTee = (id: string, patch: Partial<TeeForm>) => {
    setTeeForms((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const updateHole = (idx: number, patch: Partial<HoleForm>) => {
    setHoles((prev) => prev.map((h, i) => (i === idx ? { ...h, ...patch } : h)));
  };

  const updateHoleYardage = (idx: number, teeId: string, value: string) => {
    setHoles((prev) =>
      prev.map((h, i) => (i === idx ? { ...h, yardages: { ...h.yardages, [teeId]: value } } : h)),
    );
  };

  // ── GPS capture ─────────────────────────────────────────────────────
  const useMyLocation = async () => {
    setLocating(true);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        Alert.alert('Location permission needed', 'Allow location access to drop a pin here.');
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;
      setCoord({ lat, lng });
      mapRef.current?.animateToRegion({
        latitude: lat, longitude: lng,
        latitudeDelta: 0.01, longitudeDelta: 0.01,
      }, 500);
    } catch (e: any) {
      Alert.alert('Could not get location', e?.message ?? 'Try again.');
    } finally {
      setLocating(false);
    }
  };

  // ── Step transitions / validation ───────────────────────────────────
  const canAdvanceStep1 = courseName.trim().length > 0
    && teeForms.length > 0
    && teeForms.every((t) => t.name.trim().length > 0);

  // Real-time per-step issues so Next stays honest about what's missing.
  const step1Hint = useMemo(() => {
    if (!courseName.trim()) return 'Course name is required.';
    if (teeForms.some((t) => !t.name.trim())) return 'Every tee set needs a name (e.g. Black, White, Red).';
    return null;
  }, [courseName, teeForms]);

  // ── Step 2 → computed totals + soft warnings ───────────────────────
  const stepTotals = useMemo(() => {
    const perTee: Record<string, { yards: number; missing: number }> = {};
    for (const t of teeForms) perTee[t.id] = { yards: 0, missing: 0 };
    let par = 0;
    for (const h of holes) {
      par += Number(h.par) || 0;
      for (const t of teeForms) {
        const v = Number(h.yardages[t.id]);
        if (Number.isFinite(v) && v > 0) perTee[t.id].yards += v;
        else perTee[t.id].missing += 1;
      }
    }
    return { par, perTee };
  }, [holes, teeForms]);

  const step2Issues = useMemo(() => {
    const out: string[] = [];
    // HCP uniqueness
    const hcps = holes.map((h) => Number(h.handicap)).filter((n) => Number.isFinite(n));
    const dupHcp = hcps.length !== new Set(hcps).size;
    if (dupHcp) out.push('Handicap rankings must be unique (1 through ' + numHoles + ', no repeats).');
    if (hcps.some((n) => n < 1 || n > numHoles)) out.push(`Handicaps must be between 1 and ${numHoles}.`);
    // Par range
    if (holes.some((h) => !PAR_CHOICES.includes(Number(h.par)))) out.push('Every hole needs a par (3, 4, 5, or 6).');
    // Totals sanity
    if (numHoles === 18 && stepTotals.par > 0 && (stepTotals.par < 64 || stepTotals.par > 78)) {
      out.push(`Total par ${stepTotals.par} is outside the usual 64..78 for 18 holes.`);
    }
    if (numHoles === 9 && stepTotals.par > 0 && (stepTotals.par < 32 || stepTotals.par > 40)) {
      out.push(`Total par ${stepTotals.par} is outside the usual 32..40 for 9 holes.`);
    }
    return out;
  }, [holes, numHoles, stepTotals.par]);

  const canAdvanceStep2 = step2Issues.every((m) => !m.startsWith('Handicap rankings') && !m.startsWith('Handicaps must') && !m.startsWith('Every hole'));

  // ── Submit ─────────────────────────────────────────────────────────
  const submit = async () => {
    setSubmitting(true);
    setServerWarnings([]);
    try {
      const lat = coord?.lat;
      const lng = coord?.lng;
      const teeboxes = teeForms.map((t) => ({
        name: t.name.trim(),
        gender: t.gender,
        courseRating: t.rating ? Number(t.rating) : undefined,
        slopeRating:  t.slope  ? Number(t.slope)  : undefined,
        holes: holes.map((h, i) => ({
          hole_num: i + 1,
          par:      Number(h.par),
          yardage:  h.yardages[t.id] ? Number(h.yardages[t.id]) : null,
          handicap: h.handicap ? Number(h.handicap) : null,
        })),
      }));

      const res = await api.courses.create({
        courseName: courseName.trim(),
        city:    city.trim()       || undefined,
        state:   stateField.trim() || undefined,
        country: country.trim()    || undefined,
        latitude:  Number.isFinite(lat as number) ? lat : undefined,
        longitude: Number.isFinite(lng as number) ? lng : undefined,
        numHoles,
        teeboxes,
      });

      setServerWarnings(res.warnings ?? []);

      Alert.alert(
        'Course added!',
        (res.estimated_teebox_ids?.length
          ? 'We estimated rating/slope for one or more tee sets from your hole data — an admin can refine later. '
          : '') + 'Want to drop pin locations on the greens now?',
        [
          { text: 'Not now', onPress: () => router.replace(`/course/${res.course_id}` as any) },
          { text: 'Set pins', onPress: () => router.replace(`/course/admin-pins/${res.course_id}` as any) },
        ],
      );
    } catch (e: any) {
      const msg = e?.message ?? 'Try again.';
      // Server-side hard validation errors come back as 400 with a `details`
      // array. The request helper bubbles `error` as the message; details
      // come through unstructured here, so just show what we have.
      Alert.alert('Could not submit', msg);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <View style={s.container}>
      <Stack.Screen options={{
        title: step === 1 ? 'Add a Course' : step === 2 ? 'Enter Holes' : 'Review',
        headerStyle: { backgroundColor: C.bg },
        headerTintColor: C.text,
      }} />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ padding: 20, paddingBottom: 120 }}
          automaticallyAdjustKeyboardInsets
          keyboardShouldPersistTaps="handled"
        >
          {/* Step indicator */}
          <View style={s.steps}>
            {[1, 2, 3].map((n) => (
              <View key={n} style={[s.stepDot, step === (n as Step) && s.stepDotActive, step > n && s.stepDotDone]}>
                <Text style={[s.stepDotText, step === (n as Step) && s.stepDotTextActive]}>{n}</Text>
              </View>
            ))}
          </View>

          {step === 1 && (
            <Step1
              courseName={courseName} setCourseName={setCourseName}
              city={city} setCity={setCity}
              stateField={stateField} setStateField={setStateField}
              country={country} setCountry={setCountry}
              coord={coord} setCoord={setCoord}
              initialRegion={initialRegion} mapRef={mapRef}
              locating={locating} useMyLocation={useMyLocation}
              numHoles={numHoles} changeNumHoles={changeNumHoles}
              teeForms={teeForms}
              updateTee={updateTee}
              addTeeSet={addTeeSet} removeTeeSet={removeTeeSet}
              hint={step1Hint}
            />
          )}

          {step === 2 && (
            <Step2
              numHoles={numHoles}
              teeForms={teeForms}
              holes={holes}
              updateHole={updateHole}
              updateHoleYardage={updateHoleYardage}
              totals={stepTotals}
              issues={step2Issues}
            />
          )}

          {step === 3 && (
            <Step3
              courseName={courseName}
              city={city} stateField={stateField}
              coord={coord}
              numHoles={numHoles}
              teeForms={teeForms}
              totals={stepTotals}
              serverWarnings={serverWarnings}
            />
          )}
        </ScrollView>

        {/* Footer nav */}
        <View style={s.footer}>
          {step > 1 && (
            <TouchableOpacity style={s.backBtn} onPress={() => setStep((step - 1) as Step)} disabled={submitting}>
              <Text style={s.backBtnText}>← Back</Text>
            </TouchableOpacity>
          )}
          <View style={{ flex: 1 }} />
          {step < 3 && (
            <TouchableOpacity
              style={[s.nextBtn, (!canAdvanceStep1 && step === 1) && { opacity: 0.4 }, (!canAdvanceStep2 && step === 2) && { opacity: 0.4 }]}
              onPress={() => setStep((step + 1) as Step)}
              disabled={(step === 1 && !canAdvanceStep1) || (step === 2 && !canAdvanceStep2)}
            >
              <Text style={s.nextBtnText}>{step === 1 ? 'Next: Enter Holes' : 'Next: Review'}</Text>
            </TouchableOpacity>
          )}
          {step === 3 && (
            <TouchableOpacity style={[s.nextBtn, submitting && { opacity: 0.6 }]} onPress={submit} disabled={submitting}>
              {submitting ? <ActivityIndicator color={C.bg} /> : <Text style={s.nextBtnText}>Submit</Text>}
            </TouchableOpacity>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 1 — Basics
// ────────────────────────────────────────────────────────────────────────────

function Step1(props: {
  courseName: string; setCourseName: (s: string) => void;
  city: string; setCity: (s: string) => void;
  stateField: string; setStateField: (s: string) => void;
  country: string; setCountry: (s: string) => void;
  coord: { lat: number; lng: number } | null;
  setCoord: (c: { lat: number; lng: number }) => void;
  initialRegion: Region;
  mapRef: React.MutableRefObject<MapView | null>;
  locating: boolean; useMyLocation: () => void;
  numHoles: 9 | 18; changeNumHoles: (n: 9 | 18) => void;
  teeForms: TeeForm[];
  updateTee: (id: string, patch: Partial<TeeForm>) => void;
  addTeeSet: () => void; removeTeeSet: (id: string) => void;
  hint: string | null;
}) {
  return (
    <>
      <Text style={s.intro}>
        Add a course to the catalog. You&apos;ll enter the hole-by-hole details next,
        and we&apos;ll estimate rating/slope if you don&apos;t know them.
      </Text>

      <Field label="Course Name *">
        <TextInput
          style={s.input}
          value={props.courseName}
          onChangeText={props.setCourseName}
          placeholder="e.g. Pebble Beach Golf Links"
          placeholderTextColor={C.textMuted}
          autoCapitalize="words"
        />
      </Field>

      <Field label="Location">
        <Text style={s.subHint}>
          Tap the map to drop a pin where the course is, or use the button
          to pin your current spot. Drag the pin to fine-tune.
        </Text>
        <TouchableOpacity style={s.gpsBtn} onPress={props.useMyLocation} disabled={props.locating}>
          {props.locating
            ? <ActivityIndicator color={C.gold} size="small" />
            : <Text style={s.gpsBtnText}>📍  Use my current location</Text>}
        </TouchableOpacity>
        <View style={s.mapWrap}>
          <MapView
            ref={props.mapRef}
            style={s.map}
            initialRegion={props.initialRegion}
            mapType="hybrid"
            onPress={(e) => {
              const { latitude, longitude } = e.nativeEvent.coordinate;
              props.setCoord({ lat: latitude, lng: longitude });
            }}
          >
            {props.coord && (
              <Marker
                coordinate={{ latitude: props.coord.lat, longitude: props.coord.lng }}
                pinColor="gold"
                draggable
                onDragEnd={(e) => {
                  const { latitude, longitude } = e.nativeEvent.coordinate;
                  props.setCoord({ lat: latitude, lng: longitude });
                }}
              />
            )}
          </MapView>
        </View>
        <Text style={s.coordReadout}>
          {props.coord
            ? `📍 ${props.coord.lat.toFixed(6)}, ${props.coord.lng.toFixed(6)}`
            : 'No location set yet.'}
        </Text>
        <View style={s.row}>
          <View style={{ flex: 1 }}>
            <Text style={s.subLabel}>City</Text>
            <TextInput
              style={s.input} value={props.city} onChangeText={props.setCity}
              placeholder="Newport" placeholderTextColor={C.textMuted} autoCapitalize="words"
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.subLabel}>State</Text>
            <TextInput
              style={s.input} value={props.stateField} onChangeText={props.setStateField}
              placeholder="NY" placeholderTextColor={C.textMuted} autoCapitalize="characters" maxLength={3}
            />
          </View>
        </View>
      </Field>

      <Field label="Number of Holes">
        <View style={s.segRow}>
          {[9, 18].map((n) => (
            <TouchableOpacity
              key={n}
              style={[s.segBtn, props.numHoles === n && s.segBtnActive]}
              onPress={() => props.changeNumHoles(n as 9 | 18)}
            >
              <Text style={[s.segBtnText, props.numHoles === n && s.segBtnTextActive]}>{n} HOLES</Text>
            </TouchableOpacity>
          ))}
        </View>
      </Field>

      <Field label="Tee Sets">
        <Text style={s.subHint}>
          One per scorecard column. Rating/slope are optional — if you leave them
          blank or unrealistic, we&apos;ll estimate from your hole data.
        </Text>
        {props.teeForms.map((t, i) => (
          <View key={t.id} style={s.teeCard}>
            <View style={s.teeHeader}>
              <Text style={s.teeIdx}>TEE {i + 1}</Text>
              {props.teeForms.length > 1 && (
                <TouchableOpacity onPress={() => props.removeTeeSet(t.id)}>
                  <Text style={s.teeRemove}>Remove</Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={s.row}>
              <View style={{ flex: 2 }}>
                <Text style={s.subLabel}>Name</Text>
                <TextInput
                  style={s.input} value={t.name}
                  onChangeText={(v) => props.updateTee(t.id, { name: v })}
                  placeholder="Black" placeholderTextColor={C.textMuted} maxLength={30}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.subLabel}>Gender</Text>
                <View style={s.segRow}>
                  {(['male', 'female'] as const).map((g) => (
                    <TouchableOpacity
                      key={g}
                      style={[s.segBtnSm, t.gender === g && s.segBtnActive]}
                      onPress={() => props.updateTee(t.id, { gender: g })}
                    >
                      <Text style={[s.segBtnTextSm, t.gender === g && s.segBtnTextActive]}>{g === 'male' ? 'M' : 'F'}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.subLabel}>Rating (optional)</Text>
                <TextInput
                  style={s.input} value={t.rating}
                  onChangeText={(v) => props.updateTee(t.id, { rating: v })}
                  placeholder="68.8" placeholderTextColor={C.textMuted}
                  keyboardType="numbers-and-punctuation" maxLength={5}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={s.subLabel}>Slope (optional)</Text>
                <TextInput
                  style={s.input} value={t.slope}
                  onChangeText={(v) => props.updateTee(t.id, { slope: v })}
                  placeholder="129" placeholderTextColor={C.textMuted}
                  keyboardType="number-pad" maxLength={3}
                />
              </View>
            </View>
          </View>
        ))}
        {props.teeForms.length < 4 && (
          <TouchableOpacity style={s.addTeeBtn} onPress={props.addTeeSet}>
            <Text style={s.addTeeBtnText}>+ Add another tee set</Text>
          </TouchableOpacity>
        )}
      </Field>

      {props.hint && <Text style={s.warnText}>{props.hint}</Text>}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 2 — Per-hole grid
// ────────────────────────────────────────────────────────────────────────────

function Step2(props: {
  numHoles: 9 | 18;
  teeForms: TeeForm[];
  holes: HoleForm[];
  updateHole: (idx: number, patch: Partial<HoleForm>) => void;
  updateHoleYardage: (idx: number, teeId: string, value: string) => void;
  totals: { par: number; perTee: Record<string, { yards: number; missing: number }> };
  issues: string[];
}) {
  return (
    <>
      <View style={s.totalsBar}>
        <Text style={s.totalsLabel}>RUNNING TOTALS</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 4 }}>
          <Text style={s.totalsNum}>Par {props.totals.par || '—'}</Text>
          {props.teeForms.map((t) => {
            const v = props.totals.perTee[t.id];
            const txt = v && v.missing === 0 ? `${v.yards} yds` : `${v?.yards ?? 0} yds (${v?.missing ?? 0} blank)`;
            return <Text key={t.id} style={s.totalsNum}>{t.name || `Tee ${t.id}`}: {txt}</Text>;
          })}
        </View>
      </View>

      {props.holes.map((h, i) => (
        <View key={i} style={s.holeCard}>
          <Text style={s.holeNum}>HOLE {i + 1}</Text>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.subLabel}>Par</Text>
              <View style={s.segRow}>
                {PAR_CHOICES.map((p) => (
                  <TouchableOpacity
                    key={p}
                    style={[s.parBtn, Number(h.par) === p && s.segBtnActive]}
                    onPress={() => props.updateHole(i, { par: String(p) })}
                  >
                    <Text style={[s.parBtnText, Number(h.par) === p && s.segBtnTextActive]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.subLabel}>HCP</Text>
              <TextInput
                style={s.input}
                value={h.handicap}
                onChangeText={(v) => props.updateHole(i, { handicap: v.replace(/[^\d]/g, '') })}
                keyboardType="number-pad"
                maxLength={2}
                placeholder={String(i + 1)}
                placeholderTextColor={C.textMuted}
              />
            </View>
          </View>
          <View style={[s.row, { flexWrap: 'wrap' }]}>
            {props.teeForms.map((t) => (
              <View key={t.id} style={{ flex: 1, minWidth: 80 }}>
                <Text style={s.subLabel}>{t.name || 'Tee'} yds</Text>
                <TextInput
                  style={s.input}
                  value={h.yardages[t.id] ?? ''}
                  onChangeText={(v) => props.updateHoleYardage(i, t.id, v.replace(/[^\d]/g, ''))}
                  keyboardType="number-pad"
                  maxLength={4}
                  placeholderTextColor={C.textMuted}
                />
              </View>
            ))}
          </View>
        </View>
      ))}

      {props.issues.length > 0 && (
        <View style={s.warnBlock}>
          {props.issues.map((m, i) => <Text key={i} style={s.warnText}>• {m}</Text>)}
        </View>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step 3 — Review
// ────────────────────────────────────────────────────────────────────────────

function Step3(props: {
  courseName: string;
  city: string; stateField: string;
  coord: { lat: number; lng: number } | null;
  numHoles: 9 | 18;
  teeForms: TeeForm[];
  totals: { par: number; perTee: Record<string, { yards: number; missing: number }> };
  serverWarnings: string[];
}) {
  const loc = [props.city.trim(), props.stateField.trim()].filter(Boolean).join(', ');
  return (
    <>
      <View style={s.reviewCard}>
        <Text style={s.reviewName}>{props.courseName || '(no name)'}</Text>
        {loc ? <Text style={s.reviewMeta}>{loc}</Text> : null}
        {props.coord ? (
          <Text style={s.reviewMeta}>📍 {props.coord.lat.toFixed(6)}, {props.coord.lng.toFixed(6)}</Text>
        ) : (
          <Text style={s.reviewWarn}>No location pinned — course won&apos;t show on the map.</Text>
        )}
        <Text style={s.reviewMeta}>{props.numHoles} holes · Total par {props.totals.par || '—'}</Text>
      </View>

      <Text style={s.subLabel}>TEE SETS</Text>
      {props.teeForms.map((t) => {
        const totals = props.totals.perTee[t.id];
        const userRating = t.rating ? Number(t.rating) : null;
        const userSlope  = t.slope  ? Number(t.slope)  : null;
        const ratingOk = userRating != null && userRating >= 55 && userRating <= 80;
        const slopeOk  = userSlope  != null && userSlope  >= 55 && userSlope  <= 155;
        const needEstimate = !ratingOk || !slopeOk;
        const est = needEstimate
          ? estimateRatingSlope(props.totals.par || (props.numHoles === 9 ? 36 : 72), totals?.yards ?? 0, t.gender)
          : null;
        return (
          <View key={t.id} style={s.reviewTee}>
            <Text style={s.reviewTeeName}>{t.name || '(unnamed tee)'} <Text style={s.reviewTeeMeta}>· {t.gender}</Text></Text>
            <Text style={s.reviewTeeMeta}>{totals?.yards ?? 0} yds total · {totals?.missing ?? 0} blank holes</Text>
            <Text style={s.reviewTeeMeta}>
              Rating {ratingOk ? userRating!.toFixed(1) : `${est?.rating ?? '—'} (est.)`}
              {' · '}
              Slope  {slopeOk  ? userSlope  : `${est?.slope  ?? '—'} (est.)`}
            </Text>
          </View>
        );
      })}

      {props.serverWarnings.length > 0 && (
        <View style={s.warnBlock}>
          <Text style={s.subLabel}>SERVER NOTES</Text>
          {props.serverWarnings.map((m, i) => <Text key={i} style={s.warnText}>• {m}</Text>)}
        </View>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Field wrapper + styles
// ────────────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 16 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  intro: { color: C.textMuted, fontSize: 13, lineHeight: 19, marginBottom: 18 },

  steps: { flexDirection: 'row', justifyContent: 'center', gap: 18, marginBottom: 18 },
  stepDot: {
    width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: C.border,
    alignItems: 'center', justifyContent: 'center',
  },
  stepDotActive: { borderColor: C.gold, backgroundColor: C.gold + '22' },
  stepDotDone: { borderColor: C.gold + '88' },
  stepDotText: { color: C.textMuted, fontWeight: '900', fontSize: 13 },
  stepDotTextActive: { color: C.gold },

  label: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1.2, marginBottom: 6 },
  subLabel: { color: C.textMuted, fontSize: 10, letterSpacing: 1, fontWeight: '700', marginBottom: 4, marginTop: 8 },
  subHint: { color: C.textMuted, fontSize: 12, lineHeight: 16, marginBottom: 8 },

  input: {
    backgroundColor: C.card, color: C.text, borderRadius: 8,
    borderWidth: 1, borderColor: C.border,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  row: { flexDirection: 'row', gap: 10 },

  gpsBtn: {
    backgroundColor: C.gold + '22', borderColor: C.gold, borderWidth: 1,
    borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginBottom: 8,
  },
  gpsBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },
  mapWrap: {
    borderRadius: 10, overflow: 'hidden',
    borderWidth: 1, borderColor: C.border,
    marginBottom: 6,
  },
  map: { width: '100%', height: 240 },
  coordReadout: {
    color: C.textMuted, fontSize: 12, marginBottom: 8,
  },

  segRow: { flexDirection: 'row', gap: 6 },
  segBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    backgroundColor: C.card, alignItems: 'center',
  },
  segBtnSm: {
    flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    backgroundColor: C.card, alignItems: 'center',
  },
  segBtnActive: { backgroundColor: C.gold, borderColor: C.gold },
  segBtnText: { color: C.textMuted, fontWeight: '900', fontSize: 12, letterSpacing: 1 },
  segBtnTextSm: { color: C.textMuted, fontWeight: '900', fontSize: 12 },
  segBtnTextActive: { color: C.bg },

  parBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: C.border,
    backgroundColor: C.card, alignItems: 'center',
  },
  parBtnText: { color: C.textMuted, fontWeight: '900', fontSize: 14 },

  teeCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 10,
  },
  teeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  teeIdx: { color: C.gold, fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  teeRemove: { color: C.red, fontSize: 12, fontWeight: '700' },
  addTeeBtn: {
    paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderColor: C.gold + '66',
    backgroundColor: 'transparent', alignItems: 'center', borderStyle: 'dashed',
  },
  addTeeBtnText: { color: C.gold, fontWeight: '700', fontSize: 13 },

  totalsBar: {
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    borderWidth: 1, borderColor: C.gold + '66', marginBottom: 14,
  },
  totalsLabel: { color: C.gold, fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  totalsNum: { color: C.text, fontSize: 13, fontWeight: '700' },

  holeCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 10,
  },
  holeNum: { color: C.gold, fontSize: 12, fontWeight: '900', letterSpacing: 1, marginBottom: 4 },

  warnBlock: { marginTop: 8, padding: 10, backgroundColor: C.gold + '11', borderRadius: 8, borderWidth: 1, borderColor: C.gold + '55' },
  warnText: { color: C.gold, fontSize: 12, lineHeight: 18 },

  reviewCard: {
    backgroundColor: C.card, borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: C.gold + '55', marginBottom: 16,
  },
  reviewName: { color: C.text, fontSize: 18, fontWeight: '900', fontFamily: F.serif },
  reviewMeta: { color: C.textMuted, fontSize: 13, marginTop: 4 },
  reviewWarn: { color: C.gold, fontSize: 12, marginTop: 4 },
  reviewTee: {
    backgroundColor: C.card, borderRadius: 8, padding: 12,
    borderWidth: 1, borderColor: C.border, marginBottom: 8,
  },
  reviewTeeName: { color: C.text, fontSize: 14, fontWeight: '700' },
  reviewTeeMeta: { color: C.textMuted, fontSize: 12, marginTop: 2 },

  footer: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.bg,
  },
  backBtn: { paddingHorizontal: 14, paddingVertical: 10 },
  backBtnText: { color: C.textMuted, fontWeight: '700' },
  nextBtn: { backgroundColor: C.gold, paddingHorizontal: 18, paddingVertical: 12, borderRadius: 8 },
  nextBtnText: { color: C.bg, fontWeight: '900', letterSpacing: 0.5 },
});
