/**
 * Putting + approach proximity stats card.
 *
 *   <PuttingApproachStats userId={user.user_id} />
 *
 * Premium-only insight surface. Renders two grouped tables: putting make %
 * by distance bucket, and approach proximity-to-pin by start distance. Each
 * row shows the user's number against the PGA Tour scratch baseline so the
 * player can see exactly where they're losing strokes relative to the bar
 * they're climbing toward.
 *
 * Bars are rendered with simple absolute-width Views — no chart library
 * dependency. The user's bar is scaled relative to the wider of (their
 * value, scratch value) so the comparison is honest at extremes.
 *
 * Self-contained: fetches its own data, handles loading + empty states,
 * shows a "needs more shots" message instead of empty rows when the user
 * hasn't accumulated enough data yet.
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { C } from '../lib/colors';

type Putting = {
  bucket: string;
  attempts: number;
  made: number;
  make_pct: number | null;
  scratch_make_pct: number;
};
type Approach = {
  bucket: string;
  shots: number;
  avg_proximity_ft: number | null;
  scratch_proximity_ft: number;
};

interface Props {
  userId: string;
}

export function PuttingApproachStats({ userId }: Props) {
  const [data, setData] = useState<{ putting: Putting[]; approach: Approach[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.users.shotStats(userId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: any) => {
        if (cancelled) return;
        // 403 = not premium; surface a friendly note instead of an error.
        if (e?.status === 403) setError('Premium feature');
        else setError(e?.message ?? 'Failed to load');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>SHOT BREAKDOWN</Text>
        <ActivityIndicator color={C.gold} style={{ marginVertical: 24 }} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>SHOT BREAKDOWN</Text>
        <Text style={s.errorText}>{error}</Text>
      </View>
    );
  }
  if (!data) return null;

  const totalPuttAttempts = data.putting.reduce((a, b) => a + b.attempts, 0);
  const totalApproachShots = data.approach.reduce((a, b) => a + b.shots, 0);

  // If the user has effectively no data in either category, show a single
  // "needs more rounds" prompt instead of two empty tables.
  if (totalPuttAttempts === 0 && totalApproachShots === 0) {
    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>SHOT BREAKDOWN</Text>
        <Text style={s.emptyText}>
          Track shots in a few ranked rounds to unlock your putting and
          approach analytics. Compares your numbers against the PGA Tour
          averages from Mark Broadie's strokes-gained research, so you can
          see exactly where you're leaking strokes.
        </Text>
      </View>
    );
  }

  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>SHOT BREAKDOWN</Text>
      <Text style={s.sectionSub}>your numbers vs the PGA Tour average · Broadie baselines</Text>

      {/* ── Putting ──────────────────────────────────────────────── */}
      <Text style={s.subhead}>PUTTING — make % by distance</Text>
      {totalPuttAttempts === 0 ? (
        <Text style={s.emptySubText}>No putts tracked yet.</Text>
      ) : (
        <View style={s.table}>
          {data.putting.map((row) => (
            <PuttRow key={row.bucket} row={row} />
          ))}
        </View>
      )}

      {/* ── Approach ─────────────────────────────────────────────── */}
      <Text style={[s.subhead, { marginTop: 18 }]}>APPROACH — avg proximity to pin</Text>
      {totalApproachShots === 0 ? (
        <Text style={s.emptySubText}>No approach shots tracked yet.</Text>
      ) : (
        <View style={s.table}>
          {data.approach.map((row) => (
            <ApproachRow key={row.bucket} row={row} />
          ))}
        </View>
      )}
    </View>
  );
}

/** A single putting bucket row. Bars are sized relative to the wider of
 *  (player make%, scratch make%) so deltas read clearly at any zoom. */
function PuttRow({ row }: { row: Putting }) {
  const userPct = row.make_pct ?? 0;
  const scratchPct = row.scratch_make_pct;
  const max = Math.max(userPct, scratchPct, 100);
  const userWidth = (userPct / max) * 100;
  const scratchWidth = (scratchPct / max) * 100;
  const delta = row.make_pct != null ? row.make_pct - scratchPct : null;
  const hasData = row.attempts > 0;

  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{row.bucket}</Text>
      <View style={s.barCol}>
        {/* Scratch reference line — drawn as a faint full-width bar so the
            user's bar sits on top with a clear "you vs them" picture. */}
        <View style={[s.barTrack, { width: `${scratchWidth}%`, backgroundColor: C.textDim }]} />
        {hasData && (
          <View
            style={[
              s.barFill,
              {
                width: `${userWidth}%`,
                backgroundColor: deltaColor(delta, true),
              },
            ]}
          />
        )}
      </View>
      <View style={s.numCol}>
        <Text style={[s.userNum, !hasData && s.dim]}>
          {hasData ? `${row.make_pct}%` : '—'}
        </Text>
        <Text style={s.scratchNum}>vs {scratchPct}%</Text>
      </View>
      <Text style={[s.deltaNum, { color: deltaColor(delta, true) }]}>
        {delta != null ? formatDelta(delta, '%') : ''}
      </Text>
    </View>
  );
}

/** A single approach bucket row. Inverted delta sense — LOWER proximity is
 *  better — so the green/red coloring flips vs putting. */
function ApproachRow({ row }: { row: Approach }) {
  const userFt = row.avg_proximity_ft ?? 0;
  const scratchFt = row.scratch_proximity_ft;
  const max = Math.max(userFt, scratchFt) || 1;
  const userWidth = (userFt / max) * 100;
  const scratchWidth = (scratchFt / max) * 100;
  // For approach, delta = user - scratch. Positive (user is farther) = worse.
  const delta = row.avg_proximity_ft != null ? row.avg_proximity_ft - scratchFt : null;
  const hasData = row.shots > 0;

  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{row.bucket}</Text>
      <View style={s.barCol}>
        <View style={[s.barTrack, { width: `${scratchWidth}%`, backgroundColor: C.textDim }]} />
        {hasData && (
          <View
            style={[
              s.barFill,
              {
                width: `${userWidth}%`,
                backgroundColor: deltaColor(delta, false),
              },
            ]}
          />
        )}
      </View>
      <View style={s.numCol}>
        <Text style={[s.userNum, !hasData && s.dim]}>
          {hasData ? `${row.avg_proximity_ft} ft` : '—'}
        </Text>
        <Text style={s.scratchNum}>vs {scratchFt} ft</Text>
      </View>
      <Text style={[s.deltaNum, { color: deltaColor(delta, false) }]}>
        {delta != null ? formatDelta(delta, ' ft') : ''}
      </Text>
    </View>
  );
}

/** Higher-is-better metrics (putting make %): positive delta = green.
 *  Lower-is-better metrics (approach proximity): positive delta = red. */
function deltaColor(delta: number | null, higherIsBetter: boolean): string {
  if (delta == null || Math.abs(delta) < 0.5) return C.textMuted;
  const good = higherIsBetter ? delta > 0 : delta < 0;
  return good ? C.green : C.red;
}

function formatDelta(delta: number, unit: string): string {
  const rounded = Math.round(delta * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}${unit}`;
}

const s = StyleSheet.create({
  section: {
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: C.border,
  },
  sectionTitle: {
    color: C.gold,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.4,
  },
  sectionSub: {
    color: C.textMuted,
    fontSize: 10,
    marginTop: 3,
    marginBottom: 14,
    fontStyle: 'italic',
  },
  subhead: {
    color: C.textMuted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.1,
    marginBottom: 10,
  },
  table: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowLabel: {
    color: C.text,
    fontSize: 11,
    fontWeight: '700',
    width: 78,
  },
  barCol: {
    flex: 1,
    height: 18,
    position: 'relative',
    backgroundColor: C.bg,
    borderRadius: 3,
    overflow: 'hidden',
  },
  // Faint scratch baseline bar drawn underneath the user bar.
  barTrack: {
    position: 'absolute',
    left: 0, top: 0, bottom: 0,
    opacity: 0.5,
  },
  // User's bar — sits on top of the scratch line.
  barFill: {
    position: 'absolute',
    left: 0, top: 3, bottom: 3,
    borderRadius: 2,
    opacity: 0.95,
  },
  numCol: {
    width: 64,
    alignItems: 'flex-end',
  },
  userNum: {
    color: C.text,
    fontSize: 12,
    fontWeight: '800',
  },
  scratchNum: {
    color: C.textDim,
    fontSize: 9,
    marginTop: 1,
  },
  deltaNum: {
    fontSize: 10,
    fontWeight: '800',
    width: 50,
    textAlign: 'right',
  },
  dim: { color: C.textDim },
  errorText: {
    color: C.textMuted,
    fontSize: 12,
    marginVertical: 14,
    textAlign: 'center',
  },
  emptyText: {
    color: C.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  emptySubText: {
    color: C.textDim,
    fontSize: 11,
    marginTop: 4,
    marginBottom: 4,
    fontStyle: 'italic',
  },
});
